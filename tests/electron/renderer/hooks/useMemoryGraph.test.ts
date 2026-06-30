import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMemoryGraph } from '../../../../src/electron/renderer/hooks/useMemoryGraph';

vi.mock('../../../../src/electron/renderer/hooks/useIpc', () => ({
  useIpc: vi.fn(() => ({
    data: { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, totalMemories: 0, projectCount: 0, activeDays: 0, dailyGrowth: [] } },
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

describe('useMemoryGraph', () => {
  it('返回 graph 与 loading 状态', async () => {
    const { result } = renderHook(() => useMemoryGraph());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.graph.nodes).toEqual([]);
  });
});
