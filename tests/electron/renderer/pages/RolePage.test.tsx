/**
 * RolePage 组件测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { RolePage } from '../../../../src/electron/renderer/pages/RolePage';
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

function createProject(overrides?: Partial<Project>): Project {
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
    ...overrides,
  };
}

function setupMocks() {
  mockInvoke.mockImplementation(async (method: string, params?: { role?: string; projectId?: string }) => {
    switch (method) {
      case 'role.service.status':
        return { running: false, enabledProjects: 0, runningProjects: [] };
      case 'project.list':
        return [createProject()];
      case 'project.role.status.get':
        return { status: { running: false } };
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
        return { members: [] };
      case 'project.labels':
        return { labels: [] };
      case 'project.protected-branches':
        return { branches: [] };
      case 'project.branches':
        return { branches: [] };
      default:
        return { success: true };
    }
  });
}

describe('RolePage', () => {
  it('reviewer 页面显示 自动评审 标题', async () => {
    setupMocks();
    await renderAndStabilize(<RolePage role="reviewer" />);
    await waitFor(() => {
      expect(screen.getByText('自动评审')).toBeTruthy();
    });
  });

  it('maintainer 页面显示 自动维护 标题', async () => {
    setupMocks();
    await renderAndStabilize(<RolePage role="maintainer" />);
    await waitFor(() => {
      expect(screen.getByText('自动维护')).toBeTruthy();
    });
  });
});
