import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/advance/classic/memory/everos-api.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/advance/classic/memory/everos-api.js')>();
  return {
    ...actual,
    everosMemoryGet: vi.fn(),
  };
});

import { handlers } from '../../../src/advance/ipc/handlers.js';
import { everosMemoryGet } from '../../../src/advance/classic/memory/everos-api.js';

describe('memory.graph Maintainer episode query', () => {
  it('会用已知 Agent owner 查询其 episode，避免漏掉项目级 Maintainer 记忆', async () => {
    vi.mocked(everosMemoryGet).mockImplementation(async params => {
      if (params.ownerKind === 'user' && params.ownerId === 'maintainer' && params.memoryType === 'episode') {
        return {
          episodes: [
            {
              id: 'episode-1',
              user_id: 'maintainer',
              sender_ids: ['maintainer'],
              session_id: 'maintainer-proj-a-mr-1558',
              summary: '维护记忆',
              timestamp: '2026-07-22T03:22:08Z',
            },
          ],
          profiles: [],
          agent_cases: [],
          agent_skills: [],
          total_count: 1,
        };
      }
      return { episodes: [], profiles: [], agent_cases: [], agent_skills: [], total_count: 0 };
    });

    const result = await handlers['memory.graph']({
      everosUrl: 'http://everos.test',
      registry: {
        list: vi.fn().mockReturnValue([{ id: 'proj-a', name: 'Project A', rootPath: '/a' }]),
      },
      store: {
        listMemoryOwners: vi.fn().mockReturnValue([]),
      },
    } as any, {});

    expect(result.nodes.some(node => node.id === 'agent:maintainer')).toBe(true);
    expect(result.stats.totalMemories).toBe(1);
    expect(everosMemoryGet).toHaveBeenCalledWith(expect.objectContaining({
      ownerKind: 'user',
      ownerId: 'maintainer',
      memoryType: 'episode',
    }));
  });
});
