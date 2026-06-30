import { useIpc } from './useIpc';
import type { MemoryGraph } from '../../shared/types.js';

const EMPTY_GRAPH: MemoryGraph = {
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

/**
 * 拉取并轮询记忆图谱数据
 */
export function useMemoryGraph() {
  const { data, loading, error, refresh } = useIpc<MemoryGraph>('memory.graph', {}, { pollInterval: 5000 });

  return {
    graph: data ?? EMPTY_GRAPH,
    loading,
    error,
    refresh,
  };
}
