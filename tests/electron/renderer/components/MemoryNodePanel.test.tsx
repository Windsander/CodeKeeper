import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryNodePanel } from '../../../../src/electron/renderer/components/MemoryNodePanel';

const node = { id: 'project:1', label: 'Project A', group: 'project' as const };
const graph = { nodes: [node], edges: [], stats: { totalNodes: 1, totalEdges: 0, totalMemories: 0, projectCount: 1, activeDays: 0, dailyGrowth: [] } };

describe('MemoryNodePanel', () => {
  it('渲染节点信息并支持关闭', () => {
    const onClose = vi.fn();
    render(<MemoryNodePanel node={node} graph={graph} onClose={onClose} />);
    expect(screen.getByText('Project A')).toBeTruthy();
    fireEvent.click(screen.getByText('×'));
    expect(onClose).toHaveBeenCalled();
  });
});
