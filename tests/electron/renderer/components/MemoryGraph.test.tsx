import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryGraph } from '../../../../src/electron/renderer/components/MemoryGraph';
import { ThemeProvider } from '../../../../src/electron/renderer/contexts/ThemeContext';

vi.mock('vis-network', () => ({
  Network: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
    setOptions: vi.fn(),
    setData: vi.fn(),
    getScale: vi.fn().mockReturnValue(1),
    getPositions: vi.fn().mockReturnValue({}),
    moveTo: vi.fn(),
    fit: vi.fn(),
    redraw: vi.fn(),
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
    forEach: vi.fn(),
    length: items?.length ?? 0,
  })),
}));

const emptyGraph = { nodes: [], edges: [], stats: { totalNodes: 0, totalEdges: 0, totalMemories: 0, projectCount: 0, activeDays: 0, dailyGrowth: [] } };

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  window.electronAPI = {
    invoke: vi.fn().mockResolvedValue('dark'),
  } as unknown as Window['electronAPI'];
});

describe('MemoryGraph', () => {
  it('渲染画布容器', () => {
    const { container } = render(
      <ThemeProvider>
        <MemoryGraph graph={emptyGraph} />
      </ThemeProvider>
    );
    expect(container.querySelector('.memory-graph-canvas')).toBeTruthy();
  });
});
