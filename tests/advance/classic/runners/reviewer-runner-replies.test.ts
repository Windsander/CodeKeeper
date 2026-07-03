import { describe, it, expect, vi } from 'vitest';
import { ReviewerRunner } from '../../../../src/advance/classic/runners/reviewer-runner.js';
import {
  formatAgentFooter,
  REVIEWER_ROLE_LABEL,
} from '../../../../src/advance/classic/runners/shared/review-utils.js';
import type { MrAgentState } from '../../../../src/advance/classic/runners/shared/state-utils.js';
import type { Discussion, MergeRequest, ReviewFinding } from '../../../../src/advance/classic/provider/types.js';
import type { ReviewerBrain } from '../../../../src/advance/classic/review/reviewer-brain.js';
import type { GitLabProvider } from '../../../../src/advance/classic/provider/gitlab-provider.js';

function makeMr(): MergeRequest {
  return {
    iid: 1300,
    title: 'feat: 示例 MR',
    description: '',
    sourceBranch: 'feature/test',
    targetBranch: 'main',
    author: 'alice',
    draft: false,
    changesCount: 1,
    createdAt: '2026-07-03T05:00:00Z',
    updatedAt: '2026-07-03T06:06:00Z',
    webUrl: 'http://example.com/mr/1300',
  };
}

function makeState(stateKey: string, currentReviewedAt: number): MrAgentState {
  return {
    version: 1,
    discussions: {},
    interactiveThreads: {},
    processedDiscussions: {},
    reviewState: {
      [stateKey]: {
        findingsHash: 'old-hash',
        findingsKeys: [],
        reviewedAt: currentReviewedAt,
        headSha: 'old-sha',
      },
    },
    reviewerThreadState: {},
  };
}

describe('ReviewerRunner.handleThreadReplies 基线时间', () => {
  it('应使用上一轮 reviewedAt 作为基线，而不是当前运行已更新的 reviewedAt', async () => {
    const runner = new ReviewerRunner({
      llmClient: { complete: vi.fn() } as unknown as import('../../../../src/advance/llm/client.js').LlmClient,
    });

    const mr = makeMr();
    const stateKey = 'feature:test:main';
    const previousReviewedAt = Date.parse('2026-07-03T06:00:00.000Z');
    const currentReviewedAt = Date.parse('2026-07-03T06:05:00.000Z');
    const state = makeState(stateKey, currentReviewedAt);

    const agentBody = formatAgentFooter(REVIEWER_ROLE_LABEL, 'Reviewer 测试');
    const discussions: Discussion[] = [
      {
        id: 'd1',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'codekeeper-bot',
            body: `## 测试 finding\n\n${agentBody}`,
            createdAt: '2026-07-03T05:55:00Z',
            resolved: false,
          },
          {
            id: 2,
            author: 'alice',
            body: '这个 medium issue 能详细说明一下吗？',
            createdAt: '2026-07-03T06:02:00Z',
            resolved: false,
          },
        ],
      },
    ];

    const brain = {
      replyToComment: vi.fn().mockResolvedValue({
        shouldReply: true,
        replyBody: '因为这里缺少错误处理，可能导致异常被吞掉。',
        reason: '用户要求澄清',
      }),
    } as unknown as ReviewerBrain;

    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitLabProvider;

    const previousReview = {
      findingsHash: 'old-hash',
      findingsKeys: [] as string[],
      reviewedAt: previousReviewedAt,
      headSha: 'old-sha',
    };

    await (runner as any).handleThreadReplies(
      mr,
      discussions,
      [] as ReviewFinding[],
      state,
      provider,
      brain,
      'Reviewer 测试',
      previousReview
    );

    expect(brain.replyToComment).toHaveBeenCalledTimes(1);
    expect(brain.replyToComment).toHaveBeenCalledWith(
      expect.objectContaining({
        targetNote: expect.objectContaining({
          author: 'alice',
          body: '这个 medium issue 能详细说明一下吗？',
        }),
      })
    );
    expect(provider.addDiscussionNote).toHaveBeenCalledTimes(1);
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      1300,
      'd1',
      expect.stringContaining('因为这里缺少错误处理')
    );
  });

  it('当新回复时间早于上一轮 reviewedAt 时，不应重复回复', async () => {
    const runner = new ReviewerRunner({
      llmClient: { complete: vi.fn() } as unknown as import('../../../../src/advance/llm/client.js').LlmClient,
    });

    const mr = makeMr();
    const stateKey = 'feature:test:main';
    const previousReviewedAt = Date.parse('2026-07-03T06:05:00.000Z');
    const currentReviewedAt = Date.parse('2026-07-03T06:10:00.000Z');
    const state = makeState(stateKey, currentReviewedAt);

    const agentBody = formatAgentFooter(REVIEWER_ROLE_LABEL, 'Reviewer 测试');
    const discussions: Discussion[] = [
      {
        id: 'd1',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'codekeeper-bot',
            body: `## 测试 finding\n\n${agentBody}`,
            createdAt: '2026-07-03T05:55:00Z',
            resolved: false,
          },
          {
            id: 2,
            author: 'alice',
            body: '这个 medium issue 能详细说明一下吗？',
            createdAt: '2026-07-03T06:02:00Z',
            resolved: false,
          },
        ],
      },
    ];

    const brain = {
      replyToComment: vi.fn().mockResolvedValue({
        shouldReply: true,
        replyBody: '因为这里缺少错误处理。',
        reason: '用户要求澄清',
      }),
    } as unknown as ReviewerBrain;

    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitLabProvider;

    const previousReview = {
      findingsHash: 'old-hash',
      findingsKeys: [] as string[],
      reviewedAt: previousReviewedAt,
      headSha: 'old-sha',
    };

    await (runner as any).handleThreadReplies(
      mr,
      discussions,
      [] as ReviewFinding[],
      state,
      provider,
      brain,
      'Reviewer 测试',
      previousReview
    );

    expect(brain.replyToComment).not.toHaveBeenCalled();
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
  });
});
