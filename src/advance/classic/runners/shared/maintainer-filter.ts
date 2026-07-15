/**
 * Maintainer discussion 过滤逻辑
 *
 * 决定一个 discussion 是否应该进入 Maintainer 处理流程。
 */

import type { Discussion } from '../../provider/types.js';
import type { MrAgentState } from './state-utils.js';
import { isMaintainerAuthoredNote } from './review-utils.js';

/** 单条 finding 最大自动修复重试次数 */
const MAX_FIX_RETRY_ATTEMPTS = 3;

/**
 * 判断 discussion 是否应该被 Maintainer 处理
 */
export function isDiscussionPending(
  discussion: Discussion,
  state: Pick<MrAgentState, 'interactiveThreads' | 'processedDiscussions' | 'maintainerThreadState'>
): boolean {
  if (discussion.resolved || !discussion.resolvable) {
    return false;
  }

  // 如果该 discussion 还有未达重试上限的失败 fix，需要继续处理
  const threadState = state.maintainerThreadState?.[discussion.id];
  const hasPendingRetry = threadState
    ? Object.values(threadState.decisions).some(
        (d) => d.action === 'fix' && !d.fixSucceeded && d.failedAttempts < MAX_FIX_RETRY_ATTEMPTS
      )
    : false;

  const lastMaintainerNote = [...discussion.notes]
    .reverse()
    .find((note) => isMaintainerAuthoredNote(note.body));
  const isMaintainerQuestion =
    lastMaintainerNote != null && /[?？]/.test(lastMaintainerNote.body);
  const isInteractive = state.interactiveThreads[discussion.id]?.status === 'awaiting-reply';
  const awaitingReply = isInteractive || isMaintainerQuestion;

  // 如果最后一条 Maintainer note 是最终回复（fix/ignore/summary），且没有需要重试的失败项，不再处理
  if (lastMaintainerNote && !awaitingReply && !hasPendingRetry) {
    return false;
  }

  // 如果已处理过且没有新 note，且不在等待回复中：
  // - 若没有任何 Maintainer 实际回复痕迹，说明之前可能 ask/ignore 失败导致状态脏掉，允许重试
  // - 否则跳过
  const processed = state.processedDiscussions?.[discussion.id];
  const hasNewNotes = processed ? discussion.notes.length > processed.noteCount : true;
  if (processed && !hasNewNotes && !awaitingReply && !hasPendingRetry) {
    return lastMaintainerNote == null;
  }

  return true;
}
