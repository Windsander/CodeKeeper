import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryGraph } from '../../../../src/electron/renderer/components/MemoryGraph';

vi.mock('vis-network', () => ({
  Network: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
    setOptions: vi.fn(),
    getScale: vi.fn().mockReturnValue(1),
    getPositions: vi.fn().mockReturnValue({}),
    moveTo: vi.fn(),
    fit: vi.fn(),
    canvasToDOM: vi.fn().mockReturnValue({ x: 0, y: 0 }),
  })),
}));

vi.mock('vis-data', () => ({
  DataSet: vi.fn().mockImplementation((items) => ({
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    get: vi.fn().mockReturnValue(items ?? []),
    getIds: vi.fn().mockReturnValue([]),
    length: items?.length ?? 0,
  })),
}));

const emptyGraph = { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, totalMemories: 0, projectCount: 0, activeDays: 0, dailyGrowth: [] } };

describe('MemoryGraph', () => {
  it('渲染画布容器', () => {
    const { container } = render(<MemoryGraph graph={emptyGraph} />);
    expect(container.querySelector('.memory-graph-canvas')).toBeTruthy();
  });
});
