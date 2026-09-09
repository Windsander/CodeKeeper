import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GlobalRoleServices } from '../../../../src/electron/renderer/components/GlobalRoleServices.js';

describe('GlobalRoleServices', () => {
  it('展示三个角色服务并按状态提供启动/停止操作', async () => {
    const invoke = vi.fn(async (method: string, params?: { role?: string }) => {
      if (method === 'role.service.status') {
        return {
          running: params?.role === 'reviewer',
          enabledProjects: 2,
          runningProjects: ['p1', 'p2'],
        };
      }
      return { success: true };
    });
    window.electronAPI = { invoke } as unknown as Window['electronAPI'];

    render(<GlobalRoleServices />);

    await waitFor(() => expect(screen.getAllByText('Reviewer')).toHaveLength(1));
    expect(screen.getByText('Maintainer')).toBeTruthy();
    expect(screen.getByText('Archiver')).toBeTruthy();
    expect(screen.getAllByText('2 个项目可运行')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '启动' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '停止' })).toHaveLength(1);
  });

  it('点击启动后调用对应角色服务并刷新状态', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'role.service.status') {
        return { running: false, enabledProjects: 0, runningProjects: [] };
      }
      return { success: true };
    });
    window.electronAPI = { invoke } as unknown as Window['electronAPI'];

    render(<GlobalRoleServices />);
    const buttons = await screen.findAllByRole('button', { name: '启动' });
    buttons[0].click();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('role.service.start', { role: 'reviewer' });
      expect(
        invoke.mock.calls.filter(call => call[0] === 'role.service.status').length
      ).toBeGreaterThan(3);
    });
  });
});
