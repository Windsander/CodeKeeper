import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryGraphPage } from '../../../../src/electron/renderer/pages/MemoryGraphPage';
import { ThemeProvider } from '../../../../src/electron/renderer/contexts/ThemeContext';
import { LayoutProvider } from '../../../../src/electron/renderer/contexts/LayoutContext';

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
    forEach: vi.fn(),
    length: items?.length ?? 0,
  })),
}));

vi.mock('../../../../src/electron/renderer/hooks/useMemoryGraph', () => ({
  useMemoryGraph: vi.fn(() => ({
    graph: {
      nodes: [{ id: 'system', label: 'System', group: 'system' }],
      edges: [],
      stats: { totalNodes: 1, totalEdges: 0, totalMemories: 0, projectCount: 1, activeDays: 0, dailyGrowth: [] },
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

beforeEach(() => {
  delete document.documentElement.dataset.theme;
  window.electronAPI = {
    invoke: vi.fn().mockResolvedValue('dark'),
  } as unknown as Window['electronAPI'];
});

describe('MemoryGraphPage', () => {
  it('渲染记忆图谱标题和 Graph View，不含 Progress View 切换', async () => {
    render(
      <ThemeProvider>
        <LayoutProvider initialCollapsed>
          <MemoryGraphPage />
        </LayoutProvider>
      </ThemeProvider>
    );
    expect(screen.getByText('记忆图谱')).toBeTruthy();
    expect(screen.queryByText('Graph View')).toBeNull();
    expect(screen.queryByText('Progress View')).toBeNull();
  });
});
