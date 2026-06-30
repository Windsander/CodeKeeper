import { describe, it, expect } from 'vitest';
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
});
