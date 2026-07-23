import { describe, expect, it, vi } from 'vitest';
import {
  deliverReviewComment,
  isReviewCommentDeliveryPending,
} from '../../../../../src/advance/classic/runners/shared/review-comment-delivery.js';
import type { IGitProvider, MergeRequest, ReviewerComment } from '../../../../../src/advance/classic/provider/types.js';
import type { ReviewCommentDeliveryState } from '../../../../../src/advance/classic/runners/shared/state-utils.js';

const mr: MergeRequest = {
  iid: 18,
  title: '示例评审',
  description: '',
  sourceBranch: 'feature/review',
  targetBranch: 'main',
  author: 'developer',
  draft: false,
  changesCount: 1,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  webUrl: 'https://example.invalid/mr/18',
};

describe('deliverReviewComment', () => {
  it('普通评论失败后可在下一轮补偿发布', async () => {
    const provider = {
      postReviewComment: vi
        .fn()
        .mockRejectedValueOnce(new Error('网络中断'))
        .mockResolvedValueOnce(101),
    } as unknown as IGitProvider;
    const comments: ReviewerComment[] = [];
    let delivery: ReviewCommentDeliveryState | undefined;

    const first = await deliverReviewComment({
      provider,
      mr,
      body: '示例 summary',
      comments,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });
    expect(first.pending).toBe(true);
    expect(delivery?.status).toBe('failed');

    const second = await deliverReviewComment({
      provider,
      mr,
      body: '示例 summary',
      comments,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });

    expect(second).toMatchObject({ posted: true, noteId: 101, pending: false });
    expect(provider.postReviewComment).toHaveBeenCalledTimes(2);
    expect(comments).toHaveLength(1);
  });

  it('已记录的 note 仍在远端时通过对账避免重复发布', async () => {
    const provider = {
      postReviewComment: vi.fn().mockResolvedValue(102),
    } as unknown as IGitProvider;
    const comments: ReviewerComment[] = [];
    let delivery: ReviewCommentDeliveryState | undefined;

    await deliverReviewComment({
      provider,
      mr,
      body: '可对账的 summary',
      comments,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });
    const callCount = vi.mocked(provider.postReviewComment).mock.calls.length;

    const result = await deliverReviewComment({
      provider,
      mr,
      body: '可对账的 summary',
      comments,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });

    expect(result).toMatchObject({ posted: true, noteId: 102, pending: false });
    expect(provider.postReviewComment).toHaveBeenCalledTimes(callCount);
  });
});

describe('isReviewCommentDeliveryPending', () => {
  it('只将非 posted 状态视为待补偿', () => {
    expect(
      isReviewCommentDeliveryPending({
        body: 'x',
        bodyHash: 'x',
        status: 'failed',
        attempts: 1,
        updatedAt: Date.now(),
      })
    ).toBe(true);
    expect(
      isReviewCommentDeliveryPending({
        body: 'x',
        bodyHash: 'x',
        status: 'posted',
        attempts: 1,
        updatedAt: Date.now(),
      })
    ).toBe(false);
  });
});
