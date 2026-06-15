import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ProjectDetail } from '../../../src/electron/renderer/pages/ProjectDetail';

describe('ProjectDetail', () => {
  beforeEach(() => {
    window.electronAPI = {
      invoke: vi.fn((method: string) => {
        if (method === 'project.context') return Promise.resolve({ content: '# Context' });
        if (method === 'project.suggestions') return Promise.resolve({ content: '建议' });
        if (method === 'project.status') return Promise.resolve({ schemaVersion: 1, projectId: 'p1' });
        return Promise.resolve({});
      }),
      onPush: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
    };
  });

  it('应渲染 context tab', async () => {
    render(
      <MemoryRouter initialEntries={['/project/p1']}>
        <Routes>
          <Route path="/project/:id" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText('Context')).toBeTruthy();
    });
  });
});
