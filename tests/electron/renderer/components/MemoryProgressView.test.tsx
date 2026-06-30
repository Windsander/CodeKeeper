import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryProgressView } from '../../../../src/electron/renderer/components/MemoryProgressView';

const stats = {
  totalNodes: 10,
  totalEdges: 12,
  totalMemories: 20,
  projectCount: 2,
  activeDays: 5,
  dailyGrowth: [{ date: '2026-06-30', count: 3 }],
};

const graph = { nodes: [], edges: [], stats };

describe('MemoryProgressView', () => {
  it('渲染统计与增长图', () => {
    render(<MemoryProgressView stats={stats} graph={graph} />);
    expect(screen.getByText('20')).toBeTruthy();
    expect(screen.getByText('Memory Growth (Last 14 Days)')).toBeTruthy();
  });
});
