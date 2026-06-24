/**
 * RoleProjectConfig 组件测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { RoleProjectConfig } from '../../../../src/electron/renderer/components/RoleProjectConfig';
import '../../../../src/electron/renderer/roles/reviewer-role.js';
import '../../../../src/electron/renderer/roles/maintainer-role.js';
import type { Project } from '../../../../src/advance/types.js';

const mockInvoke = vi.fn();

beforeEach(() => {
  mockInvoke.mockReset();
  window.electronAPI = {
    invoke: mockInvoke,
    onPush: vi.fn(() => () => {}),
    openExternal: vi.fn(),
    showOpenDialog: vi.fn(),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    onWindowStateChange: vi.fn(() => () => {}),
  } as unknown as Window['electronAPI'];
});

async function renderAndStabilize(ui: React.ReactElement) {
  const result = render(ui);
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  });
  return result;
}

function setupMocks(options?: {
  members?: Array<{ username: string; name?: string }>;
  labels?: string[];
  protectedBranches?: string[];
  branches?: string[];
}) {
  mockInvoke.mockImplementation(async (method: string, params?: { role?: string }) => {
    switch (method) {
      case 'role.service.status':
        return { running: false, enabledProjects: 0, runningProjects: [] };
      case 'project.role.config.get':
        if (params?.role === 'maintainer') {
          return {
            config: {
              role: 'maintainer',
              enabled: false,
              reviewSchedule: '*/10 * * * *',
              learningEnabled: true,
              maintainerName: 'CodeKeeper Maintainer',
              autoFixEnabled: true,
              resolveOthersDiscussions: true,
            },
          };
        }
        return {
          config: {
            role: 'reviewer',
            enabled: false,
            reviewSchedule: '*/10 * * * *',
            learningEnabled: true,
          },
        };
      case 'project.soul.get':
        return { soul: { content: '', sourcePath: '/tmp/soul.md' } };
      case 'project.members':
        return { members: options?.members ?? [] };
      case 'project.labels':
        return { labels: options?.labels ?? [] };
      case 'project.protected-branches':
        return { branches: options?.protectedBranches ?? [] };
      case 'project.branches':
        return { branches: options?.branches ?? [] };
      case 'project.gitlab.config.update':
      case 'project.gitlab.verify':
      case 'project.role.config.update':
      case 'project.soul.update':
        return { success: true };
      default:
        throw new Error(`未 mock 的方法: ${method}`);
    }
  });
}

function createProject(): Project {
  return {
    id: 'p1',
    name: 'test-project',
    rootPath: '/tmp/test',
    registeredAt: Date.now(),
    lastScannedAt: null,
    gitlab: null,
    roles: {
      reviewer: { role: 'reviewer', enabled: false, reviewSchedule: '*/10 * * * *', learningEnabled: true },
      maintainer: {
        role: 'maintainer',
        enabled: false,
        reviewSchedule: '*/10 * * * *',
        learningEnabled: true,
        maintainerName: 'CodeKeeper Maintainer',
        autoFixEnabled: true,
        resolveOthersDiscussions: true,
      },
    },
  };
}

describe('RoleProjectConfig', () => {
  it('reviewer 配置不渲染 maintainerName', async () => {
    setupMocks();
    await renderAndStabilize(
      <RoleProjectConfig role="reviewer" project={createProject()} onSaved={vi.fn()} />
    );
    expect(screen.queryByLabelText('维护者名称')).toBeNull();
  });

  it('maintainer 配置渲染维护者名称和自动修复开关', async () => {
    setupMocks();
    await renderAndStabilize(
      <RoleProjectConfig role="maintainer" project={createProject()} onSaved={vi.fn()} />
    );
    expect(screen.getByLabelText('维护者名称')).toBeTruthy();
    expect(screen.getByText('启用自动修复')).toBeTruthy();
    expect(screen.getByText('自动 resolve 他人 discussion')).toBeTruthy();
  });

  it('保存时调用 project.role.config.update 并携带角色配置', async () => {
    setupMocks();
    const onSaved = vi.fn();
    await renderAndStabilize(
      <RoleProjectConfig role="maintainer" project={createProject()} onSaved={onSaved} />
    );

    const urlInput = screen.getByPlaceholderText('https://gitlab.com/group/project');
    fireEvent.change(urlInput, { target: { value: 'https://gitlab.com/group/project' } });

    const tokenInput = screen.getByPlaceholderText('请输入 GitLab Access Token');
    fireEvent.change(tokenInput, { target: { value: 'tok' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = mockInvoke.mock.calls.find((call) => call[0] === 'project.role.config.update');
      expect(call).toBeTruthy();
      expect((call![1] as { role: string }).role).toBe('maintainer');
      expect((call![1] as { config: { maintainerName: string } }).config.maintainerName).toBe(
        'CodeKeeper Maintainer'
      );
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });
});
