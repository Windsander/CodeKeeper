import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../../src/advance/project-registry';
import { handlers, type HandlerContext } from '../../../src/advance/ipc/handlers';
import type { LocalModelServiceManager } from '../../../src/advance/classic/memory/local-model-service.js';

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
});
