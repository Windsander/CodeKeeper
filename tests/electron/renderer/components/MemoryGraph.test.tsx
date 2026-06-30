import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryGraph } from '../../../../src/electron/renderer/components/MemoryGraph';

vi.mock('vis-network', () => ({
  Network: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('vis-data', () => ({
  DataSet: vi.fn().mockImplementation((items) => items),
}));

const emptyGraph = { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, totalMemories: 0, projectCount: 0, activeDays: 0, dailyGrowth: [] } };

describe('MemoryGraph', () => {
  it('渲染画布容器', () => {
    const { container } = render(<MemoryGraph graph={emptyGraph} />);
    expect(container.querySelector('.memory-graph-canvas')).toBeTruthy();
  });
});
