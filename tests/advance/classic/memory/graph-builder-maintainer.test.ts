import { describe, expect, it } from 'vitest';
import { buildMemoryGraph } from '../../../../src/advance/classic/memory/graph-builder.js';
import type { EverOSMemoryGetResult } from '../../../../src/advance/classic/memory/everos-api.js';
import type { Project } from '../../../../src/electron/shared/types.js';

const projects: Project[] = [{ id: 'proj-a', name: 'Project A', rootPath: '/a' }];

describe('Maintainer memory graph visibility', () => {
  it('episode 的 Maintainer sender 会生成 Maintainer 节点并计入统计', () => {
    const result: EverOSMemoryGetResult = {
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

    const graph = buildMemoryGraph({ projects, getResults: new Map([['proj-a', result]]) });

    expect(graph.nodes.some((node) => node.id === 'agent:maintainer')).toBe(true);
    expect(graph.stats.totalMemories).toBe(1);
    expect(graph.stats.dailyGrowth).toHaveLength(14);
    expect(graph.stats.dailyGrowth.find((entry) => entry.date === '2026-07-22')).toEqual({
      date: '2026-07-22',
      count: 1,
    });
  });
});
