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

  it('每日增长按时间线中的已去重记忆节点计数', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
    try {
      const result = makeResult();
      result.episodes = [
        {
          id: 'memory-1',
          session_id: 'maintainer-proj-a-mr-1558',
          subject: '首次维护记录',
          summary: '首次维护记录',
          timestamp: '2026-07-28T06:50:00.000Z',
        },
        {
          id: 'memory-2',
          session_id: 'maintainer-proj-a-mr-1558',
          subject: '第二条维护记录',
          summary: '第二条维护记录',
          timestamp: '2026-07-28T06:43:00.000Z',
        },
        {
          id: 'memory-3',
          session_id: 'maintainer-proj-a-mr-1558',
          subject: '前一日维护记录',
          summary: '前一日维护记录',
          timestamp: '2026-07-27T03:54:00.000Z',
        },
        {
          id: 'memory-duplicate',
          session_id: 'maintainer-proj-a-mr-1558',
          subject: '首次维护记录',
          summary: '首次维护记录',
          timestamp: '2026-07-28T06:50:00.000Z',
        },
      ];

      const graph = buildMemoryGraph({ projects, getResults: new Map([['proj-a', result]]) });
      const timelineNodes = graph.nodes.filter(
        node => node.group === 'episode' || node.group === 'agent_case'
      );

      expect(timelineNodes).toHaveLength(3);
      expect(graph.stats.dailyGrowth.find(entry => entry.date === '2026-07-28')).toEqual({
        date: '2026-07-28',
        count: 2,
      });
      expect(graph.stats.dailyGrowth.find(entry => entry.date === '2026-07-27')).toEqual({
        date: '2026-07-27',
        count: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
