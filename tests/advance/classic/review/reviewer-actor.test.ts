import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ReviewerActor } from '../../../../src/advance/classic/review/reviewer-actor.js';
import type { GitLabProvider } from '../../../../src/advance/classic/provider/gitlab-provider.js';
import type { MergeRequest, ReviewResult } from '../../../../src/advance/classic/provider/types.js';
import type { MrAgentState } from '../../../../src/advance/classic/runners/shared/state-utils.js';
import type { Project } from '../../../../src/advance/types.js';

function createMockProvider(): GitLabProvider {
  return {
    postReviewComment: vi.fn().mockResolvedValue(undefined),
    createDiscussion: vi.fn().mockResolvedValue('discussion-1'),
    getMRShaInfo: vi
      .fn()
      .mockResolvedValue({ baseSha: 'base', headSha: 'head', startSha: 'start' }),
  } as unknown as GitLabProvider;
}

const mockProject = { id: 'p1', rootPath: '/tmp/p1', name: 'P' } as Project;

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

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

describe('ReviewerActor', () => {
  it('调用 provider 发表 summary 评论', async () => {
    const provider = createMockProvider();
    const actor = new ReviewerActor({ provider });

    await actor.postReview(mockMR, mockResult);

    expect(provider.postReviewComment).toHaveBeenCalledWith(1, expect.stringContaining('HIGH'));
    expect(provider.createDiscussion).not.toHaveBeenCalled();
  });

  it('summary 发表失败时抛出异常', async () => {
    const provider = createMockProvider();
    provider.postReviewComment = vi.fn().mockRejectedValue(new Error('GitLab 错误'));
    const actor = new ReviewerActor({ provider });

    await expect(actor.postReview(mockMR, mockResult)).rejects.toThrow('GitLab 错误');
  });

  it('为 CRITICAL/HIGH finding 创建 discussion threads', async () => {
    const provider = createMockProvider();
    const actor = new ReviewerActor({ provider, project: mockProject });
    const state: MrAgentState = {
      version: 1,
      discussions: {},
      interactiveThreads: {},
      processedDiscussions: {},
    };
    const diffs = [
      {
        oldPath: 'src/index.ts',
        newPath: 'src/index.ts',
        newFile: false,
        deletedFile: false,
        diff: '+const x',
      },
    ];

    const options = {
      diffs,
      shaInfo: { baseSha: 'b', headSha: 'h', startSha: 's' },
      stateKey: 'feature/test:main',
      state,
    };
    await actor.postReview(mockMR, mockResult, options);
    await actor.createFindingThreads(mockMR, mockResult.findings, options);

    expect(provider.createDiscussion).toHaveBeenCalledTimes(1);
    expect(provider.createDiscussion).toHaveBeenCalledWith(
      1,
      expect.stringContaining('HIGH'),
      expect.objectContaining({ newPath: 'src/index.ts', newLine: 10 })
    );
  });

  it('已创建过的 finding 不重复创建 thread', async () => {
    const provider = createMockProvider();
    const actor = new ReviewerActor({ provider, project: mockProject });
    const state: MrAgentState = {
      version: 1,
      discussions: {
        'feature/test:main': [
          {
            findingKey: 'src/index.ts:10:generic',
            discussionId: 'd-1',
            file: 'src/index.ts',
            line: 10,
            severity: 'HIGH',
            resolved: false,
          },
        ],
      },
      interactiveThreads: {},
      processedDiscussions: {},
    };

    const options = {
      diffs: [
        {
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '+const x',
        },
      ],
      shaInfo: { baseSha: 'b', headSha: 'h', startSha: 's' },
      stateKey: 'feature/test:main',
      state,
    };
    await actor.postReview(mockMR, mockResult, options);
    await actor.createFindingThreads(mockMR, mockResult.findings, options);

    expect(provider.createDiscussion).not.toHaveBeenCalled();
  });

  it('summary 失败时不创建 threads', async () => {
    const provider = createMockProvider();
    provider.postReviewComment = vi.fn().mockRejectedValue(new Error('GitLab 错误'));
    const actor = new ReviewerActor({ provider, project: mockProject });
    const state: MrAgentState = {
      version: 1,
      discussions: {},
      interactiveThreads: {},
      processedDiscussions: {},
    };

    await expect(
      actor.postReview(mockMR, mockResult, {
        diffs: [],
        shaInfo: { baseSha: 'b', headSha: 'h', startSha: 's' },
        stateKey: 'k',
        state,
      })
    ).rejects.toThrow('GitLab 错误');

    expect(provider.createDiscussion).not.toHaveBeenCalled();
  });

  it('summary 重试复用状态中持久化的正文', async () => {
    const provider = createMockProvider();
    provider.postReviewComment = vi.fn().mockResolvedValue(101);
    const actor = new ReviewerActor({ provider });
    const stateKey = 'feature/test:main';
    const persistedBody = '持久化的 summary 正文\n\n固定签名';
    const state: MrAgentState = {
      version: 1,
      discussions: {},
      interactiveThreads: {},
      processedDiscussions: {},
      reviewCommentDelivery: {
        [stateKey]: {
          summary: {
            body: persistedBody,
            bodyHash: hashBody(persistedBody),
            status: 'failed',
            attempts: 1,
            lastError: 'network error',
            updatedAt: 1,
          },
        },
      },
    };

    await actor.postReview(mockMR, mockResult, {
      stateKey,
      state,
      comments: [],
    });

    expect(provider.postReviewComment).toHaveBeenCalledWith(mockMR.iid, persistedBody);
  });

  it('append 重试复用状态中持久化的正文', async () => {
    const provider = createMockProvider();
    provider.postReviewComment = vi.fn().mockResolvedValue(102);
    const actor = new ReviewerActor({ provider });
    const stateKey = 'feature/test:main';
    const persistedBody = '持久化的 append 正文\n\n固定签名';
    const state: MrAgentState = {
      version: 1,
      discussions: {},
      interactiveThreads: {},
      processedDiscussions: {},
      reviewCommentDelivery: {
        [stateKey]: {
          append: {
            body: persistedBody,
            bodyHash: hashBody(persistedBody),
            status: 'pending',
            attempts: 2,
            updatedAt: 2,
          },
        },
      },
    };

    await actor.appendSupplementaryReview(mockMR, mockResult.findings, {
      stateKey,
      state,
      comments: [],
    });

    expect(provider.postReviewComment).toHaveBeenCalledWith(mockMR.iid, persistedBody);
  });
});
