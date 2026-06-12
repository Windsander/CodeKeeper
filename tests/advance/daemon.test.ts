import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../src/advance/project-registry';
import { Daemon } from '../../src/advance/daemon';

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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-daemon-'));
    store = new MetadataStore(join(dir, 'test.db'));
    registry = new ProjectRegistry({ store });
    daemon = new Daemon({ registry, store });
  });

  afterEach(() => {
    daemon.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('启动和停止状态正确', () => {
    expect(daemon.isRunning()).toBe(false);
    daemon.start();
    expect(daemon.isRunning()).toBe(true);
    daemon.stop();
    expect(daemon.isRunning()).toBe(false);
  });

  it('注册项目后启动能监听到事件', async () => {
    const projectDir = mkdtempSync(join(dir, 'project-'));
    mkdirSync(join(projectDir, '.codekeeper'));
    writeFileSync(join(projectDir, '.codekeeper', 'config.yaml'), 'include:\n  - "**/*.md"\n');
    registry.register(projectDir);

    daemon.start();
    await waitCondition(() => daemon.isRunning(), 1000);
    // 等待 watcher 就绪后再写入文件
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeFileSync(join(projectDir, 'note.md'), 'hello');
    await waitCondition(
      () => store.listPendingEvents().some((e) => e.filePath.endsWith('note.md')),
      3000,
    );
    daemon.stop();

    const events = store.listPendingEvents();
    expect(events.some((e) => e.filePath.endsWith('note.md'))).toBe(true);
  }, 10000);
});
