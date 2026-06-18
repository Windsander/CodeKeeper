/**
 * GitLabProvider 单元测试
 *
 * 覆盖：
 * 1. 构造器不报错
 * 2. listOpenMRs 字段映射正确
 * 3. getReviewerComments 过滤 system notes 和 bot
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabProvider } from '../../../../src/advance/classic/provider/gitlab-provider';
import type { GitLabMR, GitLabMRChanges, GitLabNote } from '../../../../src/gitlab/client';

// 模拟 GitLabClient
const mockListMergeRequests = vi.fn();
const mockGetMergeRequest = vi.fn();
const mockGetMergeRequestChanges = vi.fn();
const mockGetMergeRequestNotes = vi.fn();
const mockCreateNote = vi.fn();

vi.mock('../../../../src/gitlab/client', () => ({
  GitLabClient: vi.fn().mockImplementation(() => ({
    listMergeRequests: mockListMergeRequests,
    getMergeRequest: mockGetMergeRequest,
    getMergeRequestChanges: mockGetMergeRequestChanges,
    getMergeRequestNotes: mockGetMergeRequestNotes,
    createNote: mockCreateNote,
  })),
}));

describe('GitLabProvider', () => {
  const gitlabConfig = {
    baseUrl: 'https://git.example.com',
    projectPath: 'group/project',
    token: 'glpat-test-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('构造器不应抛出错误', () => {
    expect(() => new GitLabProvider(gitlabConfig)).not.toThrow();
  });

  describe('listOpenMRs', () => {
    it('应将 GitLab MR 字段正确映射为 MergeRequest', async () => {
      const mockMRs: GitLabMR[] = [
        {
          iid: 42,
          title: '修复登录漏洞',
          description: '详细描述...',
          source_branch: 'fix/login-bug',
          target_branch: 'main',
          author: { username: 'alice', name: 'Alice' },
          draft: false,
          changes_count: '3',
          created_at: '2024-01-15T08:00:00Z',
          updated_at: '2024-01-15T10:30:00Z',
          web_url: 'https://git.example.com/group/project/-/merge_requests/42',
          state: 'opened',
          merge_status: 'can_be_merged',
        },
      ];

      mockListMergeRequests.mockResolvedValue(mockMRs);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.listOpenMRs();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        iid: 42,
        title: '修复登录漏洞',
        description: '详细描述...',
        sourceBranch: 'fix/login-bug',
        targetBranch: 'main',
        author: 'alice',
        draft: false,
        changesCount: 3,
        createdAt: '2024-01-15T08:00:00Z',
        updatedAt: '2024-01-15T10:30:00Z',
        webUrl: 'https://git.example.com/group/project/-/merge_requests/42',
      });

      expect(mockListMergeRequests).toHaveBeenCalledWith({ state: 'opened' });
    });

    it('应处理空列表', async () => {
      mockListMergeRequests.mockResolvedValue([]);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.listOpenMRs();

      expect(result).toEqual([]);
    });

    it('description 为 null 时应转为空字符串', async () => {
      const mockMRs: GitLabMR[] = [
        {
          iid: 1,
          title: '无描述 MR',
          description: null,
          source_branch: 'feat/x',
          target_branch: 'main',
          author: { username: 'bob', name: 'Bob' },
          draft: true,
          changes_count: '0',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          web_url: 'https://git.example.com/1',
          state: 'opened',
          merge_status: 'unchecked',
        },
      ];

      mockListMergeRequests.mockResolvedValue(mockMRs);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.listOpenMRs();

      expect(result[0].description).toBe('');
      expect(result[0].draft).toBe(true);
    });
  });

  describe('getReviewerComments', () => {
    it('应过滤 system notes 和 bot 用户', async () => {
      const mockNotes: GitLabNote[] = [
        {
          id: 1,
          body: '系统通知：已添加 3 个提交',
          author: { username: 'gitlab', name: 'GitLab' },
          created_at: '2024-01-15T09:00:00Z',
          resolved: false,
          system: true,
        },
        {
          id: 2,
          body: 'CI 通过',
          author: { username: 'ci-bot', name: 'CI Bot' },
          created_at: '2024-01-15T09:01:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 3,
          body: '这里有个问题',
          author: { username: 'alice', name: 'Alice' },
          created_at: '2024-01-15T09:02:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 4,
          body: 'Jenkins 构建成功',
          author: { username: 'jenkins', name: 'Jenkins' },
          created_at: '2024-01-15T09:03:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 5,
          body: 'CodeKeeper 自动评审',
          author: { username: 'codekeeper', name: 'CodeKeeper' },
          created_at: '2024-01-15T09:04:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 6,
          body: '依赖更新',
          author: { username: 'dependabot', name: 'Dependabot' },
          created_at: '2024-01-15T09:05:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 7,
          body: '正常用户含 bot 子串',
          author: { username: 'robert', name: 'Robert' },
          created_at: '2024-01-15T09:06:00Z',
          resolved: false,
          system: false,
        },
      ];

      mockGetMergeRequestNotes.mockResolvedValue(mockNotes);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.getReviewerComments(42);

      // 只保留 alice 和 robert 的评论（非 system 且非 bot）
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.author)).toContain('alice');
      expect(result.map((r) => r.author)).toContain('robert');
    });

    it('bot 用户名匹配应忽略大小写', async () => {
      const mockNotes: GitLabNote[] = [
        {
          id: 1,
          body: '大小写测试',
          author: { username: 'BOT', name: 'Bot' },
          created_at: '2024-01-15T09:00:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 2,
          body: '大小写测试2',
          author: { username: 'GitLab', name: 'GitLab' },
          created_at: '2024-01-15T09:01:00Z',
          resolved: false,
          system: false,
        },
        {
          id: 3,
          body: '正常用户',
          author: { username: 'human', name: 'Human' },
          created_at: '2024-01-15T09:02:00Z',
          resolved: false,
          system: false,
        },
      ];

      mockGetMergeRequestNotes.mockResolvedValue(mockNotes);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.getReviewerComments(1);

      expect(result).toHaveLength(1);
      expect(result[0].author).toBe('human');
    });

    it('空列表应返回空数组', async () => {
      mockGetMergeRequestNotes.mockResolvedValue([]);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.getReviewerComments(1);

      expect(result).toEqual([]);
    });
  });

  describe('getMRDiff', () => {
    it('应正确统计 additions 和 deletions', async () => {
      const mockChanges: GitLabMRChanges = {
        changes: [
          {
            old_path: 'src/index.ts',
            new_path: 'src/index.ts',
            new_file: false,
            deleted_file: false,
            renamed_file: false,
            diff: '--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n console.log("hello");\n+console.log("world");\n-const x = 1;\n-const y = 2;\n+const x = 2;\n',
          },
        ],
      };

      mockGetMergeRequestChanges.mockResolvedValue(mockChanges);

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.getMRDiff(1);

      expect(result).toHaveLength(1);
      expect(result[0].additions).toBe(2);
      expect(result[0].deletions).toBe(2);
      expect(result[0].filePath).toBe('src/index.ts');
      expect(result[0].newFile).toBe(false);
      expect(result[0].deletedFile).toBe(false);
    });
  });

  describe('postReviewComment', () => {
    it('应调用 createNote 并传入正确参数', async () => {
      mockCreateNote.mockResolvedValue({ id: 100 });

      const provider = new GitLabProvider(gitlabConfig);
      await provider.postReviewComment(42, '评审意见：建议重构');

      expect(mockCreateNote).toHaveBeenCalledWith(42, '评审意见：建议重构');
    });
  });

  describe('getCIStatus', () => {
    it('应映射 pipeline 状态到统一状态', async () => {
      const testCases: Array<{
        input: string;
        expected: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'unknown';
      }> = [
        { input: 'pending', expected: 'pending' },
        { input: 'created', expected: 'pending' },
        { input: 'running', expected: 'running' },
        { input: 'success', expected: 'success' },
        { input: 'failed', expected: 'failed' },
        { input: 'canceled', expected: 'failed' },
        { input: 'skipped', expected: 'skipped' },
        { input: 'unknown_status', expected: 'unknown' },
      ];

      for (const { input, expected } of testCases) {
        mockGetMergeRequest.mockResolvedValue({
          iid: 1,
          head_pipeline: { status: input },
        });

        const provider = new GitLabProvider(gitlabConfig);
        const result = await provider.getCIStatus(1);

        expect(result).toBe(expected);
      }
    });

    it('无 pipeline 时应返回 unknown', async () => {
      mockGetMergeRequest.mockResolvedValue({
        iid: 1,
      });

      const provider = new GitLabProvider(gitlabConfig);
      const result = await provider.getCIStatus(1);

      expect(result).toBe('unknown');
    });
  });

  describe('mergeMR', () => {
    it('应抛出未实现错误', async () => {
      const provider = new GitLabProvider(gitlabConfig);
      await expect(provider.mergeMR(42, { shouldRemoveSourceBranch: true })).rejects.toThrow(
        'mergeMR 尚未实现'
      );
    });
  });
});
