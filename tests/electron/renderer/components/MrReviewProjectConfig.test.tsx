/**
 * MrReviewProjectConfig 组件测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import {
  MrReviewProjectConfig,
  type ProjectWithMrConfig,
} from '../../../../src/electron/renderer/components/MrReviewProjectConfig';

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
  // 等待 useEffect 中异步状态更新 flush，避免 act 警告
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
  mockInvoke.mockImplementation(async (method: string) => {
    switch (method) {
      case 'classic.status':
        return { running: false, enabledProjects: 0, runningProjects: [] };
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
      case 'project.mrreview.config.update':
      case 'project.soul.update':
        return { success: true };
      default:
        throw new Error(`未 mock 的方法: ${method}`);
    }
  });
}

function createProject(config?: {
  gitlab?: { baseUrl: string; projectPath: string; token: string; defaultBranch?: string };
  mrReview?: { enabled?: boolean; filter?: { conditions: Array<{ field: string; values: string[] }> } };
}): ProjectWithMrConfig {
  return {
    id: 'p1',
    name: 'test-project',
    rootPath: '/tmp/test',
    gitlab: config?.gitlab ?? null,
    mrReview: config?.mrReview
      ? {
          enabled: config.mrReview.enabled ?? false,
          agentRole: 'reviewer+auto-fixer',
          autoMergeMode: 'audit',
          reviewSchedule: '*/10 * * * *',
          learningEnabled: true,
          maxAutoMergeRisk: 'MEDIUM',
          autoFixEnabled: true,
          resolveOthersDiscussions: true,
          ...config.mrReview,
        }
      : null,
  };
}

describe('MrReviewProjectConfig', () => {
  it('未配置 Git 仓库时，Git 仓库展开，其他组折叠并显示提示', async () => {
    setupMocks();
    await renderAndStabilize(<MrReviewProjectConfig project={createProject()} onSaved={vi.fn()} />);

    // Git 仓库组内容可见
    expect(screen.getByPlaceholderText('https://gitlab.com/group/project')).toBeTruthy();

    // 其他组折叠：标题存在，但内容不可见
    expect(screen.getByText('过滤条件')).toBeTruthy();
    expect(screen.getByText('Agent 角色与策略')).toBeTruthy();
    expect(screen.getByText('Agent 个性配置（MR-Agent-SOUL.md）')).toBeTruthy();
    expect(screen.getAllByText('请先完成 Git 仓库配置').length).toBeGreaterThanOrEqual(3);

    // Agent 角色下拉在折叠内容中不可见
    expect(screen.queryByText('Reviewer（仅审计评论）')).toBeNull();
  });

  it('未配置 Git 仓库时，disabled 的配置组不可展开', async () => {
    setupMocks();
    await renderAndStabilize(<MrReviewProjectConfig project={createProject()} onSaved={vi.fn()} />);

    const filterHeader = screen.getByText('过滤条件').closest('button');
    expect(filterHeader).toBeTruthy();
    fireEvent.click(filterHeader!);

    // 展开后 Agent 角色下拉仍然不可见（说明 disabled section 没有展开）
    expect(screen.queryByText('Reviewer（仅审计评论）')).toBeNull();
  });

  it('已配置 Git 仓库时，过滤条件组显示"无过滤" badge', async () => {
    setupMocks();
    await renderAndStabilize(
      <MrReviewProjectConfig
        project={createProject({ gitlab: { baseUrl: 'https://gitlab.com', projectPath: 'group/project', token: 'tok' } })}
        onSaved={vi.fn()}
      />
    );

    expect(screen.getByText('无过滤')).toBeTruthy();
  });

  it('已配置 Git 仓库且有 filter 时，过滤条件组显示"有过滤" badge', async () => {
    setupMocks();
    await renderAndStabilize(
      <MrReviewProjectConfig
        project={createProject({
          gitlab: { baseUrl: 'https://gitlab.com', projectPath: 'group/project', token: 'tok' },
          mrReview: { filter: { conditions: [{ field: 'author', values: ['alice'] }] } },
        })}
        onSaved={vi.fn()}
      />
    );

    expect(screen.getByText('有过滤')).toBeTruthy();
  });

  it('保存时把 filter 条件一并提交', async () => {
    setupMocks();
    const onSaved = vi.fn();
    await renderAndStabilize(<MrReviewProjectConfig project={createProject()} onSaved={onSaved} />);

    const urlInput = screen.getByPlaceholderText('https://gitlab.com/group/project');
    fireEvent.change(urlInput, { target: { value: 'https://gitlab.com/group/project' } });

    const tokenInput = screen.getByPlaceholderText('请输入 GitLab Access Token');
    fireEvent.change(tokenInput, { target: { value: 'tok' } });

    // 展开过滤条件组并添加一个条件
    const filterHeader = screen.getByText('过滤条件').closest('button');
    fireEvent.click(filterHeader!);

    await waitFor(() => {
      expect(screen.getByText('+ 添加条件')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('+ 添加条件'));

    const authorInput = await screen.findByPlaceholderText('输入用户名，多个用英文逗号分隔');
    fireEvent.change(authorInput, { target: { value: 'alice' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const mrReviewCall = mockInvoke.mock.calls.find((call) => call[0] === 'project.mrreview.config.update');
      expect(mrReviewCall).toBeTruthy();
      expect((mrReviewCall![1] as { mrReview: { filter?: { conditions: unknown[] } } }).mrReview?.filter?.conditions).toEqual([
        { field: 'author', values: ['alice'] },
      ]);
    });
  });

  it('保存成功后验证 GitLab 并调用 onSaved', async () => {
    setupMocks();
    const onSaved = vi.fn();
    await renderAndStabilize(<MrReviewProjectConfig project={createProject()} onSaved={onSaved} />);

    const urlInput = screen.getByPlaceholderText('https://gitlab.com/group/project');
    fireEvent.change(urlInput, { target: { value: 'https://gitlab.com/group/project' } });

    const tokenInput = screen.getByPlaceholderText('请输入 GitLab Access Token');
    fireEvent.change(tokenInput, { target: { value: 'tok' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('project.gitlab.verify', {
        projectId: 'p1',
        gitlab: { baseUrl: 'https://gitlab.com', projectPath: 'group/project', token: 'tok', defaultBranch: 'main' },
      });
    });

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('GitLab 验证失败时不继续保存', async () => {
    setupMocks();
    mockInvoke.mockImplementation(async (method: string) => {
      if (method === 'project.gitlab.verify') {
        throw new Error('验证失败');
      }
      if (method === 'classic.status') return { running: false, enabledProjects: 0, runningProjects: [] };
      if (method === 'project.soul.get') return { soul: { content: '', sourcePath: '/tmp/soul.md' } };
      return { success: true };
    });

    const onSaved = vi.fn();
    await renderAndStabilize(<MrReviewProjectConfig project={createProject()} onSaved={onSaved} />);

    const urlInput = screen.getByPlaceholderText('https://gitlab.com/group/project');
    fireEvent.change(urlInput, { target: { value: 'https://gitlab.com/group/project' } });

    const tokenInput = screen.getByPlaceholderText('请输入 GitLab Access Token');
    fireEvent.change(tokenInput, { target: { value: 'tok' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByText('验证失败')).toBeTruthy();
    });

    expect(onSaved).not.toHaveBeenCalled();
  });
});
