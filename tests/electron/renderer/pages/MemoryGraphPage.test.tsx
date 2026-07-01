import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryGraphPage } from '../../../../src/electron/renderer/pages/MemoryGraphPage';

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
