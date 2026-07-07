import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../../src/advance/project-registry';
import { handlers, type HandlerContext } from '../../../src/advance/ipc/handlers';
import type { LocalModelServiceManager } from '../../../src/advance/classic/memory/local-model-service.js';
import {
  loadDaemonConfig,
  saveDaemonConfig,
} from '../../../src/advance/config/daemon-config.js';

vi.mock('../../../src/advance/config/daemon-config.js', () => ({
  loadDaemonConfig: vi.fn(),
  saveDaemonConfig: vi.fn(),
}));

describe('ipc handlers', () => {
  let tmp: string;
  let store: MetadataStore;
  let registry: ProjectRegistry;
  let ctx: HandlerContext;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-handlers-'));
    store = new MetadataStore(join(tmp, 'test.db'));
    registry = new ProjectRegistry({ store });
    ctx = {
      store,
      registry,
      getClient: () => null,
      getPipeline: () => ({ run: async () => {} }) as any,
    };
  });

  afterEach(() => {
    store.close();
  });

  it('project.list 返回空数组', async () => {
    const result = await handlers['project.list'](ctx, {});
    expect(result).toEqual([]);
  });

  it('project.context 读取 context.md', async () => {
    const root = mkdtempSync(join(tmp, 'project-'));
    mkdirSync(join(root, '.codekeeper'), { recursive: true });
    writeFileSync(join(root, '.codekeeper', 'context.md'), '# Context', 'utf-8');
    registry.register(root);
    const project = registry.list()[0];
    const result = await handlers['project.context'](ctx, { projectId: project.id });
    expect(result).toEqual({ content: '# Context' });
  });

  it('localModel.logs 返回对应模型日志', async () => {
    ctx.localModelManager = {
      getModelLogs: vi.fn().mockReturnValue(['embedding log line']),
    } as unknown as LocalModelServiceManager;

    const result = await handlers['localModel.logs'](ctx, { capability: 'embedding', lines: 50 });
    expect(result).toEqual({ lines: ['embedding log line'] });
  });

  it('localModel.logs 对无效 capability 抛错', async () => {
    ctx.localModelManager = {
      getModelLogs: vi.fn(),
    } as unknown as LocalModelServiceManager;

    await expect(handlers['localModel.logs'](ctx, { capability: 'invalid' })).rejects.toThrow('无效的模型能力');
  });

  describe('daemon.config', () => {
    beforeEach(() => {
      vi.mocked(loadDaemonConfig).mockReset();
      vi.mocked(saveDaemonConfig).mockReset();
    });

    it('Daemon 已启动时返回运行态配置', async () => {
      ctx.getDaemonConfig = vi.fn().mockReturnValue({
        apiKey: 'live-key',
        apiUrl: 'https://api.example.com',
        provider: 'openai',
        model: 'gpt-4o',
        headers: '',
        scanCron: '0 * * * *',
        llmRequestsPerMinute: 20,
        embeddingModel: 'embedding-model',
        rerankModel: 'rerank-model',
        everos: '',
      });

      const result = await handlers['daemon.config'](ctx, {});

      expect(result.apiKey).toBe('live-key');
      expect(result.model).toBe('gpt-4o');
      expect(loadDaemonConfig).not.toHaveBeenCalled();
    });

    it('Daemon 未启动时从持久化配置读取', async () => {
      vi.mocked(loadDaemonConfig).mockReturnValue({
        apiKey: 'persisted-key',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        scanCron: '*/10 * * * *',
        llmRequestsPerMinute: 30,
        embeddingModel: 'persisted-embedding',
        rerankModel: 'persisted-rerank',
        everos: { multimodalProvider: 'openai', multimodalModel: 'gpt-4o' },
      });

      const result = await handlers['daemon.config'](ctx, {});

      expect(result.apiKey).toBe('persisted-key');
      expect(result.model).toBe('claude-3-5-sonnet');
      expect(result.embeddingModel).toBe('persisted-embedding');
      expect(result.rerankModel).toBe('persisted-rerank');
      expect(result.everos).toBe('{"multimodalProvider":"openai","multimodalModel":"gpt-4o"}');
    });
  });

  describe('daemon.config.update', () => {
    beforeEach(() => {
      vi.mocked(loadDaemonConfig).mockReset();
      vi.mocked(saveDaemonConfig).mockReset();
    });

    it('Daemon 已启动时通过 updateDaemonConfig 更新', async () => {
      const updateDaemonConfig = vi.fn();
      ctx.updateDaemonConfig = updateDaemonConfig;

      await handlers['daemon.config.update'](ctx, {
        apiKey: 'new-key',
        provider: 'openai',
        model: 'gpt-4o-mini',
        scanCron: '*/5 * * * *',
        llmRequestsPerMinute: 10,
        embeddingModel: 'e',
        rerankModel: 'r',
      });

      expect(updateDaemonConfig).toHaveBeenCalled();
      expect(saveDaemonConfig).not.toHaveBeenCalled();
    });

    it('Daemon 未启动时直接落盘', async () => {
      const result = await handlers['daemon.config.update'](ctx, {
        apiKey: 'offline-key',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        scanCron: '*/5 * * * *',
        llmRequestsPerMinute: 10,
        embeddingModel: 'e',
        rerankModel: 'r',
      });

      expect(result.success).toBe(true);
      expect(saveDaemonConfig).toHaveBeenCalled();
      const saved = vi.mocked(saveDaemonConfig).mock.calls[0][0];
      expect(saved.apiKey).toBe('offline-key');
    });
  });
});
