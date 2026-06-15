import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActionHistory } from '../../../src/electron/renderer/pages/ActionHistory';

describe('ActionHistory', () => {
  beforeEach(() => {
    window.electronAPI = {
      invoke: vi.fn().mockResolvedValue([
        { historyId: 1, id: 'a1', sourcePath: '/x.md', type: 'move', projectId: 'p1', status: 'applied', risk: 'low', reason: '', confidence: 0, createdAt: 1 },
      ]),
      onPush: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
    };
  });

  it('应渲染历史列表', async () => {
    render(
      <MemoryRouter>
        <ActionHistory />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText('/x.md')).toBeTruthy();
      expect(screen.getByText('撤销')).toBeTruthy();
    });
  });
});
