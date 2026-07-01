import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryStatsPage } from '../../../../src/electron/renderer/pages/MemoryStatsPage';
import { ThemeProvider } from '../../../../src/electron/renderer/contexts/ThemeContext';
import { LayoutProvider } from '../../../../src/electron/renderer/contexts/LayoutContext';

vi.mock('../../../../src/electron/renderer/hooks/useMemoryGraph', () => ({
  useMemoryGraph: vi.fn(() => ({
    graph: {
      nodes: [],
      edges: [],
      stats: { totalNodes: 2, totalEdges: 1, totalMemories: 2, projectCount: 1, activeDays: 1, dailyGrowth: [{ date: '2026-07-01', count: 2 }] },
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

describe('MemoryStatsPage', () => {
  it('渲染记忆统计标题和进度卡片', async () => {
    render(
      <ThemeProvider>
        <LayoutProvider initialCollapsed>
          <MemoryStatsPage />
        </LayoutProvider>
      </ThemeProvider>
    );
    expect(screen.getByText('记忆统计')).toBeTruthy();
    expect(screen.getByText('Memory Growth (Last 14 Days)')).toBeTruthy();
  });
});
