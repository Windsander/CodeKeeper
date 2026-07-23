import type { Discussion, ReviewerComment } from './types.js';

/** Agent 单轮分析的最大远端活动条目数。 */
export const REMOTE_ACTIVITY_WINDOW_SIZE = 100;

function parseActivityTime(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/** 返回评论最近一次创建或编辑的时间。 */
export function getCommentActivityAt(comment: ReviewerComment): number {
  return Math.max(
    parseActivityTime(comment.createdAt),
    parseActivityTime(comment.updatedAt)
  );
}

/** 返回 discussion 内任一 note 最近一次创建或编辑的时间。 */
export function getDiscussionActivityAt(discussion: Discussion): number {
  return discussion.notes.reduce(
    (latest, note) => Math.max(latest, getCommentActivityAt(note)),
    0
  );
}

/** 按最近活动时间选取评论窗口，不修改输入数组。 */
export function selectRecentActiveComments(
  comments: ReviewerComment[],
  limit = REMOTE_ACTIVITY_WINDOW_SIZE
): ReviewerComment[] {
  return [...comments]
    .sort((left, right) => {
      const activityDiff = getCommentActivityAt(right) - getCommentActivityAt(left);
      return activityDiff !== 0 ? activityDiff : right.id - left.id;
    })
    .slice(0, limit);
}

/** 按 discussion 内最后交互时间选取窗口，不修改输入数组。 */
export function selectRecentActiveDiscussions(
  discussions: Discussion[],
  limit = REMOTE_ACTIVITY_WINDOW_SIZE
): Discussion[] {
  return [...discussions]
    .sort((left, right) => {
      const activityDiff = getDiscussionActivityAt(right) - getDiscussionActivityAt(left);
      return activityDiff !== 0 ? activityDiff : right.id.localeCompare(left.id);
    })
    .slice(0, limit);
}
