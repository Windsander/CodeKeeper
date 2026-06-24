/**
 * 从 discussion body 中推断 finding 信息
 *
 * 供 MaintainerRunner 处理他人创建的 discussions 时使用。
 */

import type { ReviewFinding } from '../../provider/types.js';

/**
 * 从 discussion body 中尝试推断 finding 信息
 *
 * 解析规则：
 * - 文件路径与行号：匹配 `\`path/to/file.ts:123\``
 * - severity：根据 body 中的 emoji 或关键字推断
 * - message / suggestion：从 "问题描述" 和 "修改建议" 段提取
 *
 * 解析失败返回 null。
 */
export function inferFindingFromDiscussion(body: string): Omit<ReviewFinding, 'autoFixable'> | null {
  const fileLineMatch = body.match(/`([^`]+):(\d+)`/);
  if (!fileLineMatch) return null;
  const file = fileLineMatch[1];
  const line = Number(fileLineMatch[2]);

  let severity: ReviewFinding['severity'] = 'MEDIUM';
  if (body.includes('🚨') || body.includes('严重')) severity = 'CRITICAL';
  else if (body.includes('🔴') || body.includes('高')) severity = 'HIGH';
  else if (body.includes('🟡') || body.includes('低')) severity = 'LOW';

  const ruleIdMatch = body.match(/规则\s*`([^`]+)`/);
  const ruleId = ruleIdMatch ? ruleIdMatch[1] : undefined;

  const messageMatch = body.match(/\*\*问题描述：\*\*\s*([\s\S]*?)(?=\*\*修改建议|\*\*|$)/);
  const suggestionMatch = body.match(/\*\*修改建议：\*\*\s*([\s\S]*?)$/);

  const message = messageMatch ? messageMatch[1].trim() : '未明确描述的问题';
  const suggestion = suggestionMatch ? suggestionMatch[1].trim() : '请查看 discussion 详情';

  return { severity, file, line, ruleId, message, suggestion };
}
