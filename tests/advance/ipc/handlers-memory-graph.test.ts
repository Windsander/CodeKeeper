import { describe, it, expect, vi } from 'vitest';
import { handlers } from '../../../src/advance/ipc/handlers.js';

describe('memory.graph handler', () => {
  it('EverOS 未启动时返回仅包含 system 节点的空记忆图谱', async () => {
    const ctx = {
      everosUrl: null,
      registry: { list: vi.fn().mockReturnValue([]) },
    } as any;

    const result = await handlers['memory.graph'](ctx, {});

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('system');
    expect(result.edges).toEqual([]);
    expect(result.stats.totalMemories).toBe(0);
    expect(result.stats.projectCount).toBe(0);
  });

  it('EverOS 未启动时保留已注册项目节点', async () => {
    const ctx = {
      everosUrl: null,
      registry: {
        list: vi
          .fn()
          .mockReturnValue([{ id: 'p1', name: 'Project One', rootPath: 'virtual-project/p1' }]),
      },
    } as any;

    const result = await handlers['memory.graph'](ctx, {});

    expect(result.stats.projectCount).toBe(1);
    expect(result.nodes.some((n: any) => n.id === 'project:p1')).toBe(true);
  });
});
