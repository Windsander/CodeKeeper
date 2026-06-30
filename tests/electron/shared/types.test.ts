import { describe, it, expect } from 'vitest';
import type { MemoryGraph, MemoryGraphNode } from '../../../src/electron/shared/types.js';

describe('MemoryGraph 类型', () => {
  it('节点对象应符合类型约束', () => {
    const node: MemoryGraphNode = {
      id: 'system',
      label: 'CodeKeeper-System',
      group: 'system',
    };
    expect(node.group).toBe('system');
  });

  it('图对象应包含 nodes/edges/stats', () => {
    const graph: MemoryGraph = {
      nodes: [],
      edges: [],
      stats: {
        totalNodes: 0,
        totalEdges: 0,
        totalMemories: 0,
        projectCount: 0,
        activeDays: 0,
        dailyGrowth: [],
      },
    };
    expect(graph.stats.totalNodes).toBe(0);
  });
});
