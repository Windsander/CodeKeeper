import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryGraphPage } from '../../../../src/electron/renderer/pages/MemoryGraphPage';

vi.mock('vis-network', () => ({
  DataSet: vi.fn().mockImplementation((items) => items),
  Network: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('../../../../src/electron/renderer/hooks/useMemoryGraph', () => ({
  useMemoryGraph: vi.fn(() => ({
    graph: { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, totalMemories: 0, projectCount: 0, activeDays: 0, dailyGrowth: [] } },
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

describe('MemoryGraphPage', () => {
  it('渲染两个页签', () => {
    render(<MemoryGraphPage />);
    expect(screen.getByText('Graph View')).toBeTruthy();
    expect(screen.getByText('Progress View')).toBeTruthy();
  });
});
