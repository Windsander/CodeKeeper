/**
 * Maintainer discussion 过滤逻辑
 *
 * 决定一个 discussion 是否应该进入 Maintainer 处理流程。
 */

import type { Discussion, ReviewerComment } from '../../provider/types.js';
import type {
  MrAgentState,
  MaintainerFindingDecision,
  MaintainerThreadState,
} from './state-utils.js';
import {
  isMaintainerAuthoredNote,
  isMaintainerNoFixExplanationNote,
  isAgentAuthoredNote,
  isBotAuthor,
} from './review-utils.js';
import { isDiscussionDeliveryPending } from './discussion-delivery.js';
import { getCommentActivityAt, getCommentUpdatedAt } from '../../provider/activity-window.js';

/** 单条 finding 最大自动修复重试次数 */
const MAX_FIX_RETRY_ATTEMPTS = 3;

/** 交互式 discussion 的等待回复状态 */
const INTERACTIVE_STATUS_AWAITING_REPLY = 'awaiting-reply';

/** 交互式提问等待人工回复的超时时间（毫秒），默认 3 天 */
export const INTERACTIVE_REPLY_TIMEOUT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 判断是否存在未达重试上限的失败 fix 决策
 */
function getActiveDecisionEntries(
  threadState: MaintainerThreadState
): Array<[string, MaintainerFindingDecision]> {
  if (!threadState.activeFindingKeys) return Object.entries(threadState.decisions);
  return threadState.activeFindingKeys.flatMap(key => {
    const decision = threadState.decisions[key];
    return decision ? [[key, decision] as [string, MaintainerFindingDecision]] : [];
  });
}

function hasPendingRetryDecision(threadState: MaintainerThreadState): boolean {
  return getActiveDecisionEntries(threadState).some(
    ([, decision]) =>
      decision.action === 'fix' &&
      !decision.fixSucceeded &&
      decision.failedAttempts < MAX_FIX_RETRY_ATTEMPTS
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
    latest = Math.max(latest, getCommentActivityAt(note));
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

/** 判断 discussion 正文是否包含可定位到文件和行号的 finding。 */
function hasConcreteFindingReference(discussion: Discussion): boolean {
  return discussion.notes.some(note =>
    /[A-Za-z0-9_.@*~-]+(?:\/[A-Za-z0-9_.@*~-]+)+:\d+\b/.test(note.body)
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

/** 判断所有 finding 是否都已判定为无需修复，且远端 note 已逐项说明。 */
function hasCompleteNoFixExplanation(
  discussion: Discussion,
  threadState: MaintainerThreadState
): boolean {
  const entries = getActiveDecisionEntries(threadState);
  if (entries.length === 0 || entries.some(([, decision]) => decision.action !== 'ignore')) {
    return true;
  }

  const explanationNotes = discussion.notes.filter(note =>
    isMaintainerNoFixExplanationNote(note.body)
  );
  if (explanationNotes.length === 0) return false;
  if (entries.length === 1) return true;
  return entries.every(([fileLine]) => explanationNotes.some(note => note.body.includes(fileLine)));
}

/**
 * 判断「无需修复说明补发」是否已熔断。
 *
 * 补发过一次后，若远端说明识别仍失败（常见于行号漂移导致逐条 file:line 匹配不上），
 * 不再仅因此反复补发；出现新人工回复或决策更新时熔断自动解除。
 */
export function isNoFixBackfillCapped(
  threadState: MaintainerThreadState,
  lastHumanNoteAt: number
): boolean {
  const backfilledAt = threadState.noFixExplanationBackfilledAt;
  if (!backfilledAt) return false;
  if (lastHumanNoteAt > backfilledAt) return false;
  const latestDecisionAt = Object.values(threadState.decisions).reduce(
    (latest, decision) => Math.max(latest, decision.decidedAt),
    0
  );
  return latestDecisionAt <= backfilledAt;
}

/**
 * 判断「Reviewer 推翻了此前的无需修复/已修复判断」。
 *
 * 此前结论为 ignore（含 alreadyFixed），出现新人工回复后重新决策为 fix——
 * 说明此前的无需修复判断被人类推翻，应写入反思记忆供 already-fixed 回查参考（M7）。
 */
export function isJudgmentFlipped(
  existing: MaintainerFindingDecision | undefined,
  hasNewHumanNote: boolean,
  newAction: MaintainerFindingDecision['action']
): boolean {
  return existing?.action === 'ignore' && hasNewHumanNote && newAction === 'fix';
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
  const threadState = state.maintainerThreadState?.[discussion.id];
  const processed = state.processedDiscussions?.[discussion.id];
  const sourceNoteUpdatedAt = discussion.notes[0] ? getCommentUpdatedAt(discussion.notes[0]) : 0;
  const latestDecisionAt = threadState
    ? Object.values(threadState.decisions).reduce(
        (latest, decision) => Math.max(latest, decision.decidedAt),
        0
      )
    : 0;
  const lastReviewerNoteAt = threadState?.lastReviewerNoteAt ?? 0;
  const sourceNoteBaseline =
    lastReviewerNoteAt > 0
      ? lastReviewerNoteAt
      : Math.max(latestDecisionAt, threadState?.lastSummaryAt ?? 0, processed?.processedAt ?? 0);
  const hasUpdatedSourceNote = sourceNoteUpdatedAt > sourceNoteBaseline;
  const hasPendingDelivery = isDiscussionDeliveryPending(threadState?.delivery);
  const hasPendingRetry = threadState ? hasPendingRetryDecision(threadState) : false;
  const lastHumanNoteAt = getLatestNoteTime(discussion.notes, isHumanNote);
  const backfillCapped = threadState
    ? isNoFixBackfillCapped(threadState, lastHumanNoteAt)
    : false;
  const needsNoFixExplanation = threadState
    ? !hasCompleteNoFixExplanation(discussion, threadState) && !hasPendingRetry && !backfillCapped
    : false;
  if (hasPendingDelivery) return true;
  // 已 resolved（或不可 resolve）的 thread 已被闭环：只有未完成的远端投递才允许继续，
  // 「补发无需修复说明」不足以复活它——人类已接受结论，重复补发只会制造噪音评论。
  if (discussion.resolved || !discussion.resolvable) return false;
  if (needsNoFixExplanation) return true;

  // 交互式等待回复期间保持静默：只有出现提问之后的新人工回复，
  // 或等待超时需要收尾时，才进入流程，避免每轮轮询空转打日志。
  const interactive = state.interactiveThreads[discussion.id];
  if (interactive?.status === INTERACTIVE_STATUS_AWAITING_REPLY) {
    const askedAt = interactive.askedAt;
    // 提问 note 已被删除（如人工清理）时，交互状态已脏：
    // 放行进入流程，让 processDiscussion 清理状态并重新评估
    const askNoteStillExists = discussion.notes.some(note => {
      if (!isMaintainerAuthoredNote(note.body)) return false;
      return getCommentActivityAt(note) >= askedAt - 1000;
    });
    if (!askNoteStillExists) {
      return true;
    }
    const hasNewReply = lastHumanNoteAt > askedAt;
    const timedOut = Date.now() - askedAt > INTERACTIVE_REPLY_TIMEOUT_MS;
    return hasNewReply || timedOut;
  }

  const lastMaintainerNoteAt = getLatestNoteTime(discussion.notes, note =>
    isMaintainerAuthoredNote(note.body)
  );

  // 旧状态可能只记录了 noteCount 或历史决策，但实际尚未成功发布 Maintainer 回复。
  // 只要正文包含明确的 file:line，就必须重新进入流程；纯统计报告通常没有行号，
  // 仍由统计报告分支静默跳过。
  if (lastMaintainerNoteAt === 0 && hasConcreteFindingReference(discussion)) {
    return true;
  }

  // 如果 Maintainer 已经回复/提问过，且之后没有新的人工 note：
  // - 有处理证据（决策记忆/统计报告/非 finding 记录）→ 跳过，防重复回复与自我追问；
  // - 无处理证据（如旧版本只发过轻松回复/提问）→ 放行重新评估，
  //   让真实 finding 有机会被处理；非 finding 则由 processDiscussion 静默补记证据。
  if (
    lastMaintainerNoteAt > 0 &&
    lastMaintainerNoteAt >= lastHumanNoteAt &&
    !hasPendingRetry &&
    !hasUpdatedSourceNote
  ) {
    return !hasProcessingEvidence(threadState);
  }

  // 已处理过且没有新 note、也不在等待重试
  const hasNewNotes = processed ? discussion.notes.length > processed.noteCount : true;
  if (processed && !hasNewNotes && !hasUpdatedSourceNote && !hasPendingRetry) {
    // 已处理过但没有任何处理证据（旧版本走了 non-finding 路径，
    // 只记了 noteCount、没留决策记录）→ 放行重新评估，
    // 让真实 finding 有机会被处理；有证据则安全跳过
    return !hasProcessingEvidence(threadState);
  }

  return true;
}
