import type { Discussion, IGitProvider, MergeRequest } from '../../provider/types.js';
import type { DiscussionDeliveryState } from './state-utils.js';

export interface DiscussionDeliveryResult {
  replyPosted: boolean;
  replyNoteId?: number;
  resolved: boolean;
  pending: boolean;
  error?: string;
}

function stableHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}

export function isDiscussionDeliveryPending(
  delivery: DiscussionDeliveryState | undefined
): boolean {
  if (!delivery) return false;
  if (delivery.replyStatus !== 'posted') return true;
  return delivery.resolveRequired && delivery.resolveStatus !== 'resolved';
}

/**
 * 可靠发布 Discussion 回复，并在每个远端副作用前后保存投递状态。
 *
 * 如果上次远端已成功但本地确认前退出，会先按 note ID 或完整正文对账，
 * 找到已有回复后仅补做 resolve，不重复发布评论。
 */
export async function deliverDiscussionReply(params: {
  provider: IGitProvider;
  mr: MergeRequest;
  discussion: Discussion;
  body: string;
  resolve: boolean;
  awaitingReply?: { question: string; filePath: string };
  delivery: DiscussionDeliveryState | undefined;
  setDelivery: (delivery: DiscussionDeliveryState) => void;
  checkpoint: () => void;
}): Promise<DiscussionDeliveryResult> {
  const { provider, mr, discussion, resolve, setDelivery, checkpoint } = params;
  const requestedHash = stableHash(params.body);
  const reusable = params.delivery?.replyHash === requestedHash ? params.delivery : undefined;
  const delivery: DiscussionDeliveryState = reusable ?? {
    replyBody: params.body,
    replyHash: requestedHash,
    replyStatus: 'pending',
    resolveRequired: resolve,
    resolveStatus: resolve ? 'pending' : 'not-required',
    attempts: 0,
    updatedAt: Date.now(),
  };

  delivery.replyBody = reusable?.replyBody ?? params.body;
  delivery.resolveRequired = resolve;
  if (params.awaitingReply) {
    delivery.awaitingReply = true;
    delivery.question = params.awaitingReply.question;
    delivery.filePath = params.awaitingReply.filePath;
    delivery.awaitingReplyAt ??= Date.now();
  }
  if (!resolve) delivery.resolveStatus = 'not-required';
  delivery.updatedAt = Date.now();
  setDelivery(delivery);
  checkpoint();

  const existingNote = discussion.notes.find(
    note => note.id === delivery.replyNoteId || note.body === delivery.replyBody
  );
  if (existingNote) {
    delivery.replyStatus = 'posted';
    delivery.replyNoteId = existingNote.id;
    delivery.lastError = undefined;
    delivery.updatedAt = Date.now();
    checkpoint();
  } else if (delivery.replyStatus === 'posted') {
    // 本地曾记录成功，但本次远端快照已找不到对应 note：视为被清理或状态漂移，重新补发。
    delivery.replyStatus = 'pending';
    delivery.replyNoteId = undefined;
    delivery.lastError = '远端未找到已记录的回复，等待重新投递';
    delivery.updatedAt = Date.now();
    checkpoint();
  }

  if (delivery.replyStatus !== 'posted') {
    delivery.replyStatus = 'pending';
    delivery.attempts += 1;
    delivery.updatedAt = Date.now();
    checkpoint();
    try {
      delivery.replyNoteId = await provider.addDiscussionNote(
        mr.iid,
        discussion.id,
        delivery.replyBody
      );
      delivery.replyStatus = 'posted';
      delivery.lastError = undefined;
      delivery.updatedAt = Date.now();
      if (
        typeof delivery.replyNoteId === 'number' &&
        !discussion.notes.some(note => note.id === delivery.replyNoteId)
      ) {
        discussion.notes.push({
          id: delivery.replyNoteId,
          author: 'codekeeper-agent',
          body: delivery.replyBody,
          createdAt: new Date().toISOString(),
          resolved: false,
        });
      }
      checkpoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      delivery.replyStatus = 'failed';
      delivery.lastError = message;
      delivery.updatedAt = Date.now();
      checkpoint();
      return { replyPosted: false, resolved: false, pending: true, error: message };
    }
  }

  if (resolve) {
    if (discussion.resolved) {
      delivery.resolveStatus = 'resolved';
      delivery.lastError = undefined;
      delivery.updatedAt = Date.now();
      checkpoint();
    } else if (delivery.resolveStatus !== 'resolved') {
      delivery.resolveStatus = 'pending';
      delivery.updatedAt = Date.now();
      checkpoint();
      try {
        await provider.resolveDiscussion(mr.iid, discussion.id);
        discussion.resolved = true;
        delivery.resolveStatus = 'resolved';
        delivery.lastError = undefined;
        delivery.updatedAt = Date.now();
        checkpoint();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        delivery.resolveStatus = 'failed';
        delivery.lastError = message;
        delivery.updatedAt = Date.now();
        checkpoint();
        return {
          replyPosted: true,
          replyNoteId: delivery.replyNoteId,
          resolved: false,
          pending: true,
          error: message,
        };
      }
    }
  }

  return {
    replyPosted: true,
    replyNoteId: delivery.replyNoteId,
    resolved: !resolve || discussion.resolved,
    pending: false,
  };
}
