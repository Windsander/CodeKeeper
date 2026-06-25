import { describe, it, expect, vi } from 'vitest';
import { ReviewerActor } from '../../../../src/advance/classic/review/reviewer-actor.js';
import type { GitLabProvider } from '../../../../src/advance/classic/provider/gitlab-provider.js';
import type { MergeRequest, ReviewResult } from '../../../../src/advance/classic/provider/types.js';

function createMockProvider(): GitLabProvider {
  return {
    postReviewComment: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitLabProvider;
}

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test MR',
  description: '',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  author: 'dev',
  draft: false,
  changesCount: 1,
  createdAt: '',
  updatedAt: '',
  webUrl: '',
};

const mockResult: ReviewResult = {
  findings: [
    {
      severity: 'HIGH',
      file: 'src/index.ts',
      line: 10,
      message: '问题',
      suggestion: '建议',
      autoFixable: true,
    },
  ],
  summary: '发现一个 HIGH 问题',
  autoFixable: [0],
};

describe('ReviewerActor', () => {
  it('调用 provider 发表 summary 评论', async () => {
    const provider = createMockProvider();
    const actor = new ReviewerActor({ provider });

    await actor.postReview(mockMR, mockResult);

    expect(provider.postReviewComment).toHaveBeenCalledWith(1, expect.stringContaining('HIGH'));
  });

  it('发表失败时不抛出异常', async () => {
    const provider = createMockProvider();
    provider.postReviewComment = vi.fn().mockRejectedValue(new Error('GitLab 错误'));
    const actor = new ReviewerActor({ provider });

    await expect(actor.postReview(mockMR, mockResult)).resolves.toBeUndefined();
  });
});
