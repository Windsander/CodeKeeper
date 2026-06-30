import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryNodePanel } from '../../../../src/electron/renderer/components/MemoryNodePanel';

const node = { id: 'project:1', label: 'Project A', group: 'project' as const };

describe('MemoryNodePanel', () => {
  it('渲染节点信息并支持关闭', () => {
    const onClose = vi.fn();
    render(<MemoryNodePanel node={node} onClose={onClose} />);
    expect(screen.getByText('Project A')).toBeTruthy();
    fireEvent.click(screen.getByText('×'));
    expect(onClose).toHaveBeenCalled();
  });
});
