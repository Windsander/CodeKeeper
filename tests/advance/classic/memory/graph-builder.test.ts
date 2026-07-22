import { describe, it, expect, vi } from 'vitest';
import { buildMemoryGraph, parseTopicId } from '../../../../src/advance/classic/memory/graph-builder.js';
import type { Project } from '../../../../src/electron/shared/types.js';
import type { EverOSMemoryGetResult } from '../../../../src/advance/classic/memory/everos-api.js';

const projects: Project[] = [{ id: 'proj-a', name: 'Project A', rootPath: '/a' }];

function makeResult(): EverOSMemoryGetResult {
  return {
    episodes: [],
    profiles: [],
    agent_cases: [],
    agent_skills: [],
    total_count: 0,
  };
}

describe('parseTopicId', () => {
  it('解析 reviewer MR session', () => {
    const t = parseTopicId('reviewer-proj-a-mr-42');
    expect(t).toEqual({ topicId: 'mr:42', label: 'MR !42' });
  });

  it('解析 discussion session', () => {
    const t = parseTopicId('maintainer-proj-a-discussion-7');
    expect(t).toEqual({ topicId: 'discussion:7', label: 'Discussion #7' });
  });

  it('解析 archiver slot', () => {
    const t = parseTopicId('archiver-proj-a-2026-06-30-1');
    expect(t).toEqual({ topicId: 'archive:2026-06-30-1', label: '2026-06-30-1' });
  });

  it('未知 session 返回 null', () => {
    expect(parseTopicId('legacy-123')).toBeNull();
  });
});

describe('buildMemoryGraph', () => {
  it('空输入只返回 system 和 project 节点', () => {
    const graph = buildMemoryGraph({ projects, getResults: new Map([['proj-a', makeResult()]]) });
    expect(graph.nodes.map((n) => n.id)).toEqual(['system', 'project:proj-a']);
    expect(graph.edges).toHaveLength(1);
  });

  it('每日增长固定返回最近 14 个连续自然日并补零', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
    try {
      const result = makeResult();
      result.episodes = [
        {
          id: 'episode-today',
          session_id: 'reviewer-proj-a-mr-1',
          timestamp: '2026-07-22T08:00:00.000Z',
        },
        {
          id: 'episode-two-days-ago',
          session_id: 'reviewer-proj-a-mr-2',
          timestamp: '2026-07-20T08:00:00.000Z',
        },
        {
          id: 'episode-outside-window',
          session_id: 'reviewer-proj-a-mr-3',
          timestamp: '2026-06-01T08:00:00.000Z',
        },
      ];

      const graph = buildMemoryGraph({ projects, getResults: new Map([['proj-a', result]]) });

      expect(graph.stats.dailyGrowth).toHaveLength(14);
      expect(graph.stats.dailyGrowth[0]).toEqual({ date: '2026-07-09', count: 0 });
      expect(graph.stats.dailyGrowth[11]).toEqual({ date: '2026-07-20', count: 1 });
      expect(graph.stats.dailyGrowth[12]).toEqual({ date: '2026-07-21', count: 0 });
      expect(graph.stats.dailyGrowth[13]).toEqual({ date: '2026-07-22', count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});
