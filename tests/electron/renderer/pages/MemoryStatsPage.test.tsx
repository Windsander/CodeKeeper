import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryStatsPage } from '../../../../src/electron/renderer/pages/MemoryStatsPage';

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

describe('MemoryStatsPage', () => {
  it('渲染记忆统计标题和进度卡片', () => {
    render(<MemoryStatsPage />);
    expect(screen.getByText('记忆统计')).toBeTruthy();
    expect(screen.getByText('Memory Growth (Last 14 Days)')).toBeTruthy();
  });
});
