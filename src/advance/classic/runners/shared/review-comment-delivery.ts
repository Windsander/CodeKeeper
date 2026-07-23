import { createHash } from 'node:crypto';
import type { IGitProvider, MergeRequest, ReviewerComment } from '../../provider/types.js';
import type { ReviewCommentDeliveryState } from './state-utils.js';

export interface ReviewCommentDeliveryResult {
  posted: boolean;
  noteId?: number;
  pending: boolean;
  error?: string;
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function isReviewCommentDeliveryPending(
  delivery: ReviewCommentDeliveryState | undefined
): boolean {
  return Boolean(delivery && delivery.status !== 'posted');
}

/** 可靠发布 MR 普通评论，并通过 note ID 或完整正文消除崩溃后的重复投递。 */
export async function deliverReviewComment(params: {
  provider: IGitProvider;
  mr: MergeRequest;
  body: string;
  comments: ReviewerComment[];
  delivery: ReviewCommentDeliveryState | undefined;
  setDelivery: (delivery: ReviewCommentDeliveryState) => void;
  checkpoint: () => void;
}): Promise<ReviewCommentDeliveryResult> {
  const requestedHash = hashBody(params.body);
  const reusable = params.delivery?.bodyHash === requestedHash ? params.delivery : undefined;
  const delivery: ReviewCommentDeliveryState = reusable ?? {
    body: params.body,
    bodyHash: requestedHash,
    status: 'pending',
    attempts: 0,
    updatedAt: Date.now(),
  };

  delivery.body = reusable?.body ?? params.body;
  delivery.updatedAt = Date.now();
  params.setDelivery(delivery);
  params.checkpoint();

  const existing = params.comments.find(
    comment => comment.id === delivery.noteId || comment.body === delivery.body
  );
  if (existing) {
    delivery.status = 'posted';
    delivery.noteId = existing.id;
    delivery.lastError = undefined;
    delivery.updatedAt = Date.now();
    params.checkpoint();
  } else if (delivery.status === 'posted') {
    delivery.status = 'pending';
    delivery.noteId = undefined;
    delivery.lastError = '远端未找到已记录的评论，等待重新投递';
    delivery.updatedAt = Date.now();
    params.checkpoint();
  }

  if (delivery.status !== 'posted') {
    delivery.status = 'pending';
    delivery.attempts += 1;
    delivery.updatedAt = Date.now();
    params.checkpoint();
    try {
      delivery.noteId = await params.provider.postReviewComment(params.mr.iid, delivery.body);
      delivery.status = 'posted';
      delivery.lastError = undefined;
      delivery.updatedAt = Date.now();
      if (
        typeof delivery.noteId === 'number' &&
        !params.comments.some(comment => comment.id === delivery.noteId)
      ) {
        params.comments.push({
          id: delivery.noteId,
          author: 'codekeeper-agent',
          body: delivery.body,
          createdAt: new Date().toISOString(),
          resolved: false,
        });
      }
      params.checkpoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      delivery.status = 'failed';
      delivery.lastError = message;
      delivery.updatedAt = Date.now();
      params.checkpoint();
      return { posted: false, pending: true, error: message };
    }
  }

  return { posted: true, noteId: delivery.noteId, pending: false };
}
