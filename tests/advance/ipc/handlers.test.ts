import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import { ProjectRegistry } from '../../../src/advance/project-registry';
import { handlers, type HandlerContext } from '../../../src/advance/ipc/handlers';

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
});
