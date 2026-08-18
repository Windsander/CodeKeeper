import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../../src/advance/project-registry';
import { handlers, type HandlerContext } from '../../../src/advance/ipc/handlers';
import type { LocalModelServiceManager } from '../../../src/advance/classic/memory/local-model-service.js';
import type { ArchiverProviderOrchestrator } from '../../../src/advance/archiver/provider-orchestrator.js';
import { loadDaemonConfig, saveDaemonConfig } from '../../../src/advance/config/daemon-config.js';

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

    await expect(handlers['localModel.logs'](ctx, { capability: 'invalid' })).rejects.toThrow(
      '无效的模型能力'
    );
  });

  it('拒绝角色与配置角色不一致的更新', async () => {
    const root = mkdtempSync(join(tmp, 'project-'));
    const project = registry.register(root);

    await expect(
      handlers['project.role.config.update'](ctx, {
        projectId: project.id,
        role: 'archiver',
        config: {
          role: 'reviewer',
          enabled: false,
          reviewSchedule: '*/10 * * * *',
          learningEnabled: true,
        },
      })
    ).rejects.toThrow('角色配置不匹配');
  });

  it('返回 Archiver Provider Catalog', async () => {
    const result = (await handlers['archiver.provider.catalog'](ctx, {})) as {
      providers: Array<Record<string, unknown> & { id: string }>;
    };

    expect(result.providers.map(provider => provider.id)).toEqual(
      expect.arrayContaining(['builtin', 'graphify', 'codebase-memory-mcp'])
    );
    expect(result.providers.every(provider => !('defaultExecutable' in provider))).toBe(true);
    expect(result.providers.every(provider => !('launchPresets' in provider))).toBe(true);
    expect(result.providers.every(provider => !('options' in provider))).toBe(true);
    expect(result.providers.every(provider => !('managedRuntime' in provider))).toBe(true);
    expect(result.providers.find(provider => provider.id === 'graphify')).toMatchObject({
      preparation: 'managed',
    });
    expect(result.providers.find(provider => provider.id === 'builtin')).toMatchObject({
      preparation: 'builtin',
    });
  });

  it('使用项目配置探测 Archiver Provider', async () => {
    const root = mkdtempSync(join(tmp, 'project-'));
    const project = registry.register(root);
    const probeProject = vi.fn().mockResolvedValue([
      {
        providerId: 'graphify',
        available: true,
        executable: 'virtual-provider-command',
        version: 'test',
        message: '自动选择 virtual-provider-command',
      },
    ]);
    ctx.archiverProviderOrchestrator = {
      probeProject,
    } as unknown as ArchiverProviderOrchestrator;

    const result = (await handlers['archiver.provider.probe'](ctx, {
      projectId: project.id,
    })) as {
      providers: Array<Record<string, unknown> & { providerId: string; available: boolean }>;
    };

    expect(result.providers).toEqual([
      {
        providerId: 'graphify',
        available: true,
        readiness: 'ready',
        prepared: false,
        version: 'test',
        message: '已检测到可用的本机 Provider。',
      },
    ]);
    expect(result.providers[0]).not.toHaveProperty('executable');
    expect(result.providers[0].message).toBe('已检测到可用的本机 Provider。');
    expect(probeProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: project.id }),
      expect.any(String)
    );
  });

  it('返回 Provider 运行状态时不暴露归档产物路径', async () => {
    const root = mkdtempSync(join(tmp, 'project-'));
    const project = registry.register(root);
    ctx.archiverProviderOrchestrator = {
      readStatus: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        projectId: project.id,
        generatedAt: 1,
        selectedPrimary: 'graphify',
        statuses: [
          {
            providerId: 'graphify',
            placement: 'primary',
            state: 'completed',
            startedAt: 1,
            finishedAt: 2,
            artifacts: ['virtual-archive/providers/graphify/graph.json'],
            message: '执行失败：virtual-provider-root/internal-error',
          },
        ],
      }),
    } as unknown as ArchiverProviderOrchestrator;

    const result = (await handlers['archiver.provider.status'](ctx, {
      projectId: project.id,
    })) as { status: { statuses: Array<Record<string, unknown>> } };

    expect(result.status.statuses[0]).not.toHaveProperty('artifacts');
    expect(result.status.statuses[0]).not.toHaveProperty('message');
    expect(result.status.statuses[0]).toMatchObject({
      providerId: 'graphify',
      state: 'completed',
    });
  });

  it('Provider 自动准备失败时只返回脱敏后的环境诊断', async () => {
    const root = mkdtempSync(join(tmp, 'project-'));
    const project = registry.register(root);
    ctx.archiverProviderOrchestrator = {
      probeProject: vi.fn().mockResolvedValue([
        {
          providerId: 'understand-anything',
          available: false,
          readiness: 'manual',
          prepared: false,
          message: '未检测到 Git，无法准备 Skill 资源：virtual-provider-root/internal',
        },
      ]),
    } as unknown as ArchiverProviderOrchestrator;

    const result = (await handlers['archiver.provider.probe'](ctx, {
      projectId: project.id,
    })) as { providers: Array<Record<string, unknown>> };

    expect(result.providers[0]).toMatchObject({
      providerId: 'understand-anything',
      readiness: 'manual',
      prepared: false,
      message: 'Skill 自动准备失败：未检测到可用的 Git。',
    });
    expect(JSON.stringify(result.providers[0])).not.toContain('virtual-provider-root');
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
