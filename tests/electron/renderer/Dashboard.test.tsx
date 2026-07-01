import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { LayoutProvider } from '../../../src/electron/renderer/contexts/LayoutContext';
import { Dashboard } from '../../../src/electron/renderer/pages/Dashboard';

describe('Dashboard', () => {
  beforeEach(() => {
    window.electronAPI = {
      invoke: vi.fn().mockResolvedValue([
        { id: 'p1', name: 'proj', rootPath: '/tmp', healthScore: 0.8, pending: 1, archived: 2, ignored: 0, suggestion: 1, lastScannedAt: null },
      ]),
      onPush: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
    };
  });

  it('应渲染项目列表', async () => {
    render(
      <BrowserRouter>
        <LayoutProvider>
          <Dashboard />
        </LayoutProvider>
      </BrowserRouter>
    );
    await waitFor(() => {
      expect(screen.getByText('proj')).toBeTruthy();
      expect(screen.getByText('80%')).toBeTruthy();
    });
  });
});
