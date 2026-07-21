/**
 * Maintainer discussion 过滤逻辑
 *
 * 决定一个 discussion 是否应该进入 Maintainer 处理流程。
 */

import type { Discussion, ReviewerComment } from '../../provider/types.js';
import type { MrAgentState, MaintainerFindingDecision, MaintainerThreadState } from './state-utils.js';
import { isMaintainerAuthoredNote, isAgentAuthoredNote, isBotAuthor } from './review-utils.js';

/** 单条 finding 最大自动修复重试次数 */
const MAX_FIX_RETRY_ATTEMPTS = 3;

/** 交互式 discussion 的等待回复状态 */
const INTERACTIVE_STATUS_AWAITING_REPLY = 'awaiting-reply';

/** 交互式提问等待人工回复的超时时间（毫秒），默认 3 天 */
export const INTERACTIVE_REPLY_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 判断是否存在未达重试上限的失败 fix 决策
 */
function hasPendingRetryDecision(decisions: Record<string, MaintainerFindingDecision>): boolean {
  return Object.values(decisions).some(
    (d) => d.action === 'fix' && !d.fixSucceeded && d.failedAttempts < MAX_FIX_RETRY_ATTEMPTS
  );
}

/**
 * 从 note 列表中找出满足谓词的最新一条 note 时间戳（毫秒）
 */
function getLatestNoteTime(
  notes: ReviewerComment[],
  predicate: (note: ReviewerComment) => boolean
): number {
  let latest = 0;
  for (const note of notes) {
    if (!predicate(note)) continue;
    const t = new Date(note.createdAt).getTime();
    if (!Number.isNaN(t)) {
      latest = Math.max(latest, t);
    }
  }
  return latest;
}

/**
 * 判断一条 note 是否来自真正的人类（非任何 Agent、非自动化 bot）
 */
function isHumanNote(note: ReviewerComment): boolean {
  return (
    !isAgentAuthoredNote(note.body) &&
    !isMaintainerAuthoredNote(note.body) &&
    !isBotAuthor(note.author)
  );
}

/**
 * 判断该 discussion 是否有「已处理」的证据。
 *
 * 有证据才允许跳过：决策记忆（finding 级处理）、统计报告标记、非 finding 处理记录。
 * 仅有 Maintainer note 不算证据——旧版本可能对含真实 finding 的评论
 * 只发过轻松回复/提问（non-finding 路径不记录任何东西），若仅凭 note 跳过，
 * 这些 finding 将永远没有处理机会。
 */
function hasProcessingEvidence(threadState: MaintainerThreadState | undefined): boolean {
  if (!threadState) return false;
  return (
    Object.keys(threadState.decisions).length > 0 ||
    threadState.statisticalReport === true ||
    threadState.nonFindingAction !== undefined
  );
}

/**
 * 判断 discussion 是否应该被 Maintainer 处理
 *
 * 核心原则：只有在「有新的非 Maintainer 输入」或「有需要继续重试的失败 fix」时才进入流程。
 * Maintainer 自己发布的回复/问题不会触发再次处理，避免重复回复和自我追问。
 */
export function isDiscussionPending(
  discussion: Discussion,
  state: Pick<MrAgentState, 'interactiveThreads' | 'processedDiscussions' | 'maintainerThreadState'>
): boolean {
  if (discussion.resolved || !discussion.resolvable) {
    return false;
  }

  const threadState = state.maintainerThreadState?.[discussion.id];
  const hasPendingRetry = threadState ? hasPendingRetryDecision(threadState.decisions) : false;

  const lastHumanNoteAt = getLatestNoteTime(discussion.notes, isHumanNote);

  // 交互式等待回复期间保持静默：只有出现提问之后的新人工回复，
  // 或等待超时需要收尾时，才进入流程，避免每轮轮询空转打日志。
  const interactive = state.interactiveThreads[discussion.id];
  if (interactive?.status === INTERACTIVE_STATUS_AWAITING_REPLY) {
    const askedAt = interactive.askedAt;
    // 提问 note 已被删除（如人工清理）时，交互状态已脏：
    // 放行进入流程，让 processDiscussion 清理状态并重新评估
    const askNoteStillExists = discussion.notes.some((note) => {
      if (!isMaintainerAuthoredNote(note.body)) return false;
      const t = new Date(note.createdAt).getTime();
      return !Number.isNaN(t) && t >= askedAt - 1000;
    });
    if (!askNoteStillExists) {
      return true;
    }
    const hasNewReply = lastHumanNoteAt > askedAt;
    const timedOut = Date.now() - askedAt > INTERACTIVE_REPLY_TIMEOUT_MS;
    return hasNewReply || timedOut;
  }

  const lastMaintainerNoteAt = getLatestNoteTime(discussion.notes, (note) =>
    isMaintainerAuthoredNote(note.body)
  );

  // 如果 Maintainer 已经回复/提问过，且之后没有新的人工 note：
  // - 有处理证据（决策记忆/统计报告/非 finding 记录）→ 跳过，防重复回复与自我追问；
  // - 无处理证据（如旧版本只发过轻松回复/提问）→ 放行重新评估，
  //   让真实 finding 有机会被处理；非 finding 则由 processDiscussion 静默补记证据。
  if (lastMaintainerNoteAt > 0 && lastMaintainerNoteAt >= lastHumanNoteAt && !hasPendingRetry) {
    return !hasProcessingEvidence(threadState);
  }

  // 已处理过且没有新 note、也不在等待重试
  const processed = state.processedDiscussions?.[discussion.id];
  const hasNewNotes = processed ? discussion.notes.length > processed.noteCount : true;
  if (processed && !hasNewNotes && !hasPendingRetry) {
    // 已处理过但没有任何处理证据（旧版本走了 non-finding 路径，
    // 只记了 noteCount、没留决策记录）→ 放行重新评估，
    // 让真实 finding 有机会被处理；有证据则安全跳过
    return !hasProcessingEvidence(threadState);
  }

  return true;
}
