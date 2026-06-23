/**
 * MR 评审范围过滤工具
 *
 * 对 MR 列表做本地二次过滤，确保多字段 AND、同字段 OR 语义正确。
 */

import type { MergeRequest } from './types.js';
import type { MrReviewFilter, MrReviewFilterField } from '../../types.js';

/**
 * 判断单条 MR 是否满足整个 filter
 *
 * - filter 未配置或条件为空时，返回 true（全部范围）
 * - 不同字段之间为 AND
 * - 同字段多个值之间为 OR
 */
export function matchesFilter(mr: MergeRequest, filter?: MrReviewFilter): boolean {
  if (!filter || filter.conditions.length === 0) return true;

  for (const condition of filter.conditions) {
    const values = condition.values.filter((v) => v.trim() !== '');
    if (values.length === 0) continue;

    const matched = values.some((value) => matchesCondition(mr, condition.field, value));
    if (!matched) return false;
  }

  return true;
}

function matchesCondition(mr: MergeRequest, field: MrReviewFilterField, value: string): boolean {
  switch (field) {
    case 'author':
      return mr.author === value;
    case 'assignee':
      return mr.assignee === value;
    case 'reviewer':
      return mr.reviewers?.includes(value) ?? false;
    case 'label':
      return mr.labels?.includes(value) ?? false;
    case 'sourceBranch':
      return mr.sourceBranch === value;
    case 'targetBranch':
      return mr.targetBranch === value;
    case 'draft':
      return String(mr.draft) === value;
    default:
      return true;
  }
}
