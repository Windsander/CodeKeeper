import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LayoutProvider } from '../../../src/electron/renderer/contexts/LayoutContext';
import { ProjectDetail } from '../../../src/electron/renderer/pages/ProjectDetail';

describe('ProjectDetail', () => {
  beforeEach(() => {
    window.electronAPI = {
      invoke: vi.fn((method: string) => {
        if (method === 'project.context') return Promise.resolve({ content: '# Context' });
        if (method === 'project.status')
          return Promise.resolve({ schemaVersion: 1, projectId: 'p1' });
        if (method === 'project.get')
          return Promise.resolve({ id: 'p1', name: '项目一', rootPath: '/virtual/project' });
        if (method === 'pipeline.get')
          return Promise.resolve({ exists: false, generated: false, definition: null });
        if (method === 'pipeline.runs') return Promise.resolve([]);
        if (method === 'project.archive.tree') return Promise.resolve({ tree: null });
        return Promise.resolve({});
      }),
      onPush: vi.fn().mockReturnValue(() => {}),
      openExternal: vi.fn(),
    };
  });

  it('默认进入管线 tab，并提供五个项目容器 tab', async () => {
    render(
      <MemoryRouter initialEntries={['/project/p1']}>
        <LayoutProvider>
          <Routes>
            <Route path="/project/:id" element={<ProjectDetail />} />
          </Routes>
        </LayoutProvider>
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '管线' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '运行' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '知识' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '归档' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '设置' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Status' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(screen.getByText('Context')).toBeTruthy();
  });
});
