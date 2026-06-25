/**
 * 从 discussion body 中推断 finding 信息
 *
 * 供 MaintainerRunner 处理 discussions 时使用。
 */

import type { ReviewFinding } from '../../provider/types.js';

/**
 * 从单条 discussion body 中尝试推断一个 finding 信息
 *
 * 解析规则：
 * - 优先从 body 中匹配 `\`path/to/file.ts:123\``
 * - body 中没有时，使用 discussion position 的 newPath / newLine
 * - severity：根据 body 中的 emoji 或关键字推断
 * - message / suggestion：从 "问题描述" 和 "修改建议" 段提取
 *
 * 解析失败返回 null。
 */
export function inferFindingFromDiscussion(
  body: string,
  position?: { newPath?: string; newLine?: number; oldPath?: string; oldLine?: number }
): Omit<ReviewFinding, 'autoFixable'> | null {
  let file: string | undefined;
  let line: number | undefined;

  const fileLineMatch = body.match(/`([^`]+):(\d+)`/);
  if (fileLineMatch) {
    file = fileLineMatch[1];
    line = Number(fileLineMatch[2]);
  } else if (position) {
    file = position.newPath ?? position.oldPath;
    line = position.newLine ?? position.oldLine ?? 1;
  }

  if (!file) return null;

  let severity: ReviewFinding['severity'] = 'MEDIUM';
  if (body.includes('🚨') || body.includes('严重')) severity = 'CRITICAL';
  else if (body.includes('🔴') || body.includes('高')) severity = 'HIGH';
  else if (body.includes('🟡') || body.includes('低')) severity = 'LOW';

  const ruleIdMatch = body.match(/规则\s*(?:`([^`]+)`|([^\n`·]+))/);
  const ruleId = ruleIdMatch ? (ruleIdMatch[1] ?? ruleIdMatch[2].trim()) : undefined;

  const messageMatch = body.match(/\*\*问题描述：\*\*\s*([\s\S]*?)(?=\*\*修改建议|\*\*|$)/);
  const suggestionMatch = body.match(/\*\*修改建议：\*\*\s*([\s\S]*?)$/);

  const message = messageMatch ? messageMatch[1].trim() : body.trim() || '未明确描述的问题';
  const suggestion = suggestionMatch
    ? suggestionMatch[1].trim()
    : '请查看 discussion 详情';

  return { severity, file, line: line ?? 1, ruleId, message, suggestion };
}

/**
 * 从 CodeKeeper Reviewer 的汇总评论中解析出所有 finding
 *
 * 汇总评论格式示例（以 `-` 列表组织）：
 * - 🔴 **高** (1)
 *   - `src/main/telemetry/memoryTelemetrySink.ts:30` · 规则 `DUPLICATE_REPORTING` 当...<br>**建议**：修改...
 * - 🟠 **中** (2)
 *   - `packages/.../ltmMetadataGenerator.ts:77` · 规则 `CONSISTENT_SCENE_NAMES` ...<br>**建议**：...
 */
export function inferFindingsFromReviewSummary(body: string): Omit<ReviewFinding, 'autoFixable'>[] {
  const findings: Omit<ReviewFinding, 'autoFixable'>[] = [];

  // 按 severity 分区：匹配如 "- 🔴 **高** (1)" 或 "- 🟠 **中** (2)"
  const sectionRegex = /^[•\-]\s*([🔴🟠🟡🟢])\s*\*\*[^*]+\*\*\s*\(\d+\)\s*$/gm;
  const headings: Array<{ emoji: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(body)) !== null) {
    headings.push({ emoji: match[1], index: match.index });
  }

  const sectionRanges: Array<{ emoji: string; text: string }> = [];
  for (let i = 0; i < headings.length; i++) {
    const sectionStart = body.indexOf('\n', headings[i].index) + 1;
    const sectionEnd = i < headings.length - 1 ? headings[i + 1].index : body.length;
    sectionRanges.push({ emoji: headings[i].emoji, text: body.slice(sectionStart, sectionEnd) });
  }

  // 单条 finding 正则：`- `path:line` · 规则 `RULE` message<br>**建议**：suggestion`
  const itemRegex = /^\s*-\s*`([^`\n]+):(\d+)`\s*·\s*规则\s*`([^`]+)`\s*(.*?)(?:<br>\s*\*\*建议\*\*：\s*(.*?))?(?=\n\s*-\s*`|$)/gims;

  for (const section of sectionRanges) {
    const severity = emojiToSeverity(section.emoji);
    if (!severity) continue;

    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(section.text)) !== null) {
      const [, file, lineStr, ruleId, messageRaw, suggestionRaw] = itemMatch;
      findings.push({
        severity,
        file: file.trim(),
        line: Number(lineStr),
        ruleId: ruleId.trim(),
        message: cleanSummaryText(messageRaw),
        suggestion: suggestionRaw ? cleanSummaryText(suggestionRaw) : '请查看 discussion 详情',
      });
    }
  }

  return findings;
}

function cleanSummaryText(raw: string): string {
  return raw
    .replace(/<br>/gi, '\n')
    .replace(/\*\*/g, '')
    .replace(/\n+/g, '\n')
    .trim();
}

function emojiToSeverity(emoji: string): ReviewFinding['severity'] | null {
  switch (emoji) {
    case '🔴':
      return 'HIGH';
    case '🟠':
      return 'MEDIUM';
    case '🟡':
      return 'LOW';
    case '🟢':
      return 'LOW';
    default:
      return null;
  }
}
