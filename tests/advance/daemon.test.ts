import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetadataStore } from '../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../src/advance/project-registry';
import { Daemon } from '../../src/advance/daemon';

vi.mock('../../src/advance/classic/memory/everos-service.js', () => ({
  EverOSService: class {
    async start(): Promise<string> {
      return 'http://127.0.0.1:9999';
    }
    stop(): void {}
  },
}));

vi.mock('../../src/advance/classic/memory/everos-mcp-server.js', () => ({
  EverOSMcpServer: class {
    async start(): Promise<string> {
      return 'http://127.0.0.1:9998/sse';
    }
    async stop(): Promise<void> {}
  },
}));

vi.mock('../../src/advance/classic/memory/local-model-service.js', () => ({
  LocalModelServiceManager: class {
    async start(): Promise<void> {}
    stop(): void {}
    getEmbeddingUrl(): string { return 'http://127.0.0.1:7001'; }
    getRerankUrl(): string { return 'http://127.0.0.1:7002'; }
    getStatus() {
      return {
        embedding: { state: 'running', url: 'http://127.0.0.1:7001', error: null, progress: null },
        rerank: { state: 'running', url: 'http://127.0.0.1:7002', error: null, progress: null },
      };
    }
    async restart(): Promise<void> {}
  },
}));

async function waitCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待条件超时（${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('Daemon', () => {
  let dir: string;
  let store: MetadataStore;
  let registry: ProjectRegistry;
  let daemon: Daemon;
  const originalSocketPath = process.env.CODEKEEPER_IPC_SOCKET_PATH;

  beforeEach(() => {
    // 使用独立的命名管道，避免与开发中的 daemon 实例冲突
    process.env.CODEKEEPER_IPC_SOCKET_PATH = `\\\\?\\pipe\\ck-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dir = mkdtempSync(join(tmpdir(), 'ck-daemon-'));
    store = new MetadataStore(join(dir, 'test.db'));
    registry = new ProjectRegistry({ store });
    daemon = new Daemon({ registry, store, apiKey: 'test' });
  });

  afterEach(async () => {
    await daemon.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    process.env.CODEKEEPER_IPC_SOCKET_PATH = originalSocketPath;
  });

  it('启动和停止状态正确', async () => {
    expect(daemon.isRunning()).toBe(false);
    await daemon.start();
    expect(daemon.isRunning()).toBe(true);
    await daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it('注册项目后启动能监听到事件', async () => {
    const projectDir = mkdtempSync(join(dir, 'project-'));
    mkdirSync(join(projectDir, '.codekeeper'));
    writeFileSync(join(projectDir, '.codekeeper', 'config.yaml'), 'include:\n  - "**/*.md"\n');
    registry.register(projectDir);

    await daemon.start();
    await waitCondition(() => daemon.isRunning(), 1000);
    // 等待 watcher 就绪后再写入文件（daemon 内部延迟 3s 启动 watcher）
    await new Promise((resolve) => setTimeout(resolve, 4000));
    writeFileSync(join(projectDir, 'note.md'), 'hello');
    await waitCondition(
      () => store.listPendingEvents().some((e) => e.filePath.endsWith('note.md')),
      3000,
    );
    await daemon.stop();

    const events = store.listPendingEvents();
    expect(events.some((e) => e.filePath.endsWith('note.md'))).toBe(true);
  }, 10000);
});
