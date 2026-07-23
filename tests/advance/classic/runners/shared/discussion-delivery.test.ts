import { describe, expect, it, vi } from 'vitest';
import {
  deliverDiscussionReply,
  isDiscussionDeliveryPending,
} from '../../../../../src/advance/classic/runners/shared/discussion-delivery.js';
import type { Discussion, IGitProvider, MergeRequest } from '../../../../../src/advance/classic/provider/types.js';
import type { DiscussionDeliveryState } from '../../../../../src/advance/classic/runners/shared/state-utils.js';

const mr: MergeRequest = {
  iid: 17,
  title: '示例变更',
  description: '',
  sourceBranch: 'feature/example',
  targetBranch: 'main',
  author: 'developer',
  draft: false,
  changesCount: 1,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  webUrl: 'https://example.invalid/mr/17',
};

function makeDiscussion(): Discussion {
  return {
    id: 'discussion-example',
    resolvable: true,
    resolved: false,
    notes: [
      {
        id: 1,
        author: 'reviewer-agent',
        body: '请检查 src/example.ts:12',
        createdAt: '2026-07-20T00:00:00.000Z',
        resolved: false,
      },
    ],
  };
}

describe('deliverDiscussionReply', () => {
  it('回复失败后下一轮只重试投递并继续 resolve', async () => {
    const provider = {
      addDiscussionNote: vi
        .fn()
        .mockRejectedValueOnce(new Error('暂时不可用'))
        .mockResolvedValueOnce(42),
      resolveDiscussion: vi.fn().mockResolvedValue(undefined),
    } as unknown as IGitProvider;
    const discussion = makeDiscussion();
    let delivery: DiscussionDeliveryState | undefined;
    const checkpoint = vi.fn();

    const first = await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '已检查，建议保留当前实现。',
      resolve: true,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint,
    });

    expect(first.pending).toBe(true);
    expect(delivery?.replyStatus).toBe('failed');
    expect(delivery?.attempts).toBe(1);
    expect(provider.resolveDiscussion).not.toHaveBeenCalled();

    const second = await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '已检查，建议保留当前实现。',
      resolve: true,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint,
    });

    expect(second).toMatchObject({ replyPosted: true, resolved: true, pending: false });
    expect(provider.addDiscussionNote).toHaveBeenCalledTimes(2);
    expect(provider.resolveDiscussion).toHaveBeenCalledOnce();
    expect(delivery?.replyStatus).toBe('posted');
    expect(delivery?.resolveStatus).toBe('resolved');
  });

  it('本地记录已发布但远端 note 仍存在时不重复回复', async () => {
    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValue(7),
      resolveDiscussion: vi.fn().mockResolvedValue(undefined),
    } as unknown as IGitProvider;
    const discussion = makeDiscussion();
    let delivery: DiscussionDeliveryState | undefined;

    await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '这是一条可对账的回复。',
      resolve: true,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });
    const callCount = vi.mocked(provider.addDiscussionNote).mock.calls.length;

    const recovered = await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '这是一条可对账的回复。',
      resolve: true,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });

    expect(recovered).toMatchObject({ replyPosted: true, resolved: true, pending: false });
    expect(provider.addDiscussionNote).toHaveBeenCalledTimes(callCount);
    expect(provider.resolveDiscussion).toHaveBeenCalledOnce();
  });

  it('远端 note 被清理后会按原正文重新投递', async () => {
    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValueOnce(8).mockResolvedValueOnce(9),
      resolveDiscussion: vi.fn().mockResolvedValue(undefined),
    } as unknown as IGitProvider;
    const discussion = makeDiscussion();
    let delivery: DiscussionDeliveryState | undefined;

    await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '远端清理后的补发内容。',
      resolve: false,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });
    discussion.notes = discussion.notes.filter(note => note.id !== 8);

    const recovered = await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '远端清理后的补发内容。',
      resolve: false,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });

    expect(recovered).toMatchObject({ replyPosted: true, resolved: true, pending: false });
    expect(provider.addDiscussionNote).toHaveBeenCalledTimes(2);
    expect(delivery?.replyNoteId).toBe(9);
  });

  it('人工重开已完成 discussion 时仅对账回复，不自动再次 resolve', async () => {
    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValue(12),
      resolveDiscussion: vi.fn().mockResolvedValue(undefined),
    } as unknown as IGitProvider;
    const discussion = makeDiscussion();
    let delivery: DiscussionDeliveryState | undefined;

    const completed = await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '已完成的处理结论',
      resolve: true,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });
    expect(completed.resolved).toBe(true);
    discussion.resolved = false;
    vi.mocked(provider.addDiscussionNote).mockClear();
    vi.mocked(provider.resolveDiscussion).mockClear();

    const result = await deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body: '已完成的处理结论',
      resolve: true,
      delivery,
      setDelivery: next => {
        delivery = next;
      },
      checkpoint: () => undefined,
    });

    expect(result).toMatchObject({ replyPosted: true, resolved: false, pending: false });
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(provider.resolveDiscussion).not.toHaveBeenCalled();
  });
});

describe('isDiscussionDeliveryPending', () => {
  it('只要回复或 resolve 未完成就保持 pending', () => {
    expect(
      isDiscussionDeliveryPending({
        replyBody: 'x',
        replyHash: 'x',
        replyStatus: 'failed',
        resolveRequired: false,
        resolveStatus: 'not-required',
        attempts: 1,
        updatedAt: Date.now(),
      })
    ).toBe(true);
    expect(
      isDiscussionDeliveryPending({
        replyBody: 'x',
        replyHash: 'x',
        replyStatus: 'posted',
        resolveRequired: true,
        resolveStatus: 'failed',
        attempts: 1,
        updatedAt: Date.now(),
      })
    ).toBe(true);
    expect(
      isDiscussionDeliveryPending({
        replyBody: 'x',
        replyHash: 'x',
        replyStatus: 'posted',
        resolveRequired: true,
        resolveStatus: 'resolved',
        attempts: 1,
        updatedAt: Date.now(),
      })
    ).toBe(false);
  });
});
