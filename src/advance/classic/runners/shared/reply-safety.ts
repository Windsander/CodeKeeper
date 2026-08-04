/** 远端 discussion 回复的硬性安全上限。 */
export const MAX_DISCUSSION_REPLY_CHARS = 16_000;

/** 单条 finding 原因的展示上限，避免底层日志淹没整条回复。 */
export const MAX_DISCUSSION_REASON_CHARS = 1_200;

const MAX_REPLY_LINE_CHARS = 1_600;
const MAX_REASON_LINES = 12;
const REASON_HEAD_LINES = 3;
const REASON_TAIL_LINES = 3;
const MAX_DIAGNOSTIC_LINES = 5;
const TRUNCATION_NOTICE =
  '> 诊断内容过长，已由 Maintainer 自动截断；完整输出保留在本地运行日志中。';

const STRONG_DIAGNOSTIC_PATTERN =
  /error\s+TS\d+|syntaxerror|typeerror|referenceerror|assertionerror|no exported member|cannot find|could not resolve|is not assignable|expected \d+ arguments?|permission denied|authentication failed|fatal:/i;
const FALLBACK_DIAGNOSTIC_PATTERN = /\b(?:error|failed|failure|rejected)\b/i;

/** 去除 ANSI 与空字符，避免终端控制序列泄漏到 Git 平台。 */
export function stripTerminalControlCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\0/g, '');
}

function capLine(line: string, maxChars = MAX_REPLY_LINE_CHARS): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 压缩单条失败/忽略原因，同时保留开头、关键错误行和日志尾部。 */
export function compactDiscussionReason(
  reason: string,
  maxChars = MAX_DISCUSSION_REASON_CHARS
): string {
  const normalized = stripTerminalControlCodes(reason).replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '未提供具体原因';

  const lines = normalized
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(REASON_HEAD_LINES, lines.length); index++) {
    selected.add(index);
  }

  const strongDiagnostics = lines
    .map((line, index) => ({ line, index }))
    .filter(item => STRONG_DIAGNOSTIC_PATTERN.test(item.line))
    .slice(0, MAX_DIAGNOSTIC_LINES);
  const diagnostics =
    strongDiagnostics.length > 0
      ? strongDiagnostics
      : lines
          .map((line, index) => ({ line, index }))
          .filter(item => FALLBACK_DIAGNOSTIC_PATTERN.test(item.line))
          .slice(0, MAX_DIAGNOSTIC_LINES);
  for (const diagnostic of diagnostics) selected.add(diagnostic.index);

  for (let index = Math.max(0, lines.length - REASON_TAIL_LINES); index < lines.length; index++) {
    selected.add(index);
  }

  const visibleLines = Array.from(selected)
    .sort((left, right) => left - right)
    .slice(0, MAX_REASON_LINES)
    .map(index => capLine(lines[index]));
  const omittedCount = Math.max(0, lines.length - visibleLines.length);
  if (omittedCount > 0) visibleLines.push(`… 已省略 ${omittedCount} 行`);

  const compacted = visibleLines.join('\n');
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 对整条 discussion 回复做最后一道确定性限流。
 *
 * 保留 Agent footer，正文过长时只发布前部摘要与截断提示；该函数必须保持幂等，
 * 以便投递状态可以安全地按压缩后的正文做哈希和重试。
 */
export function compactDiscussionReplyBody(
  body: string,
  maxChars = MAX_DISCUSSION_REPLY_CHARS
): string {
  let lineTruncated = false;
  const normalized = stripTerminalControlCodes(body)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => {
      if (line.length > MAX_REPLY_LINE_CHARS) lineTruncated = true;
      return capLine(line);
    })
    .join('\n')
    .trim();
  if (normalized.length <= maxChars && !lineTruncated) return normalized;

  const footerMarker = '\n\n---\n*生成于';
  const footerIndex = normalized.lastIndexOf(footerMarker);
  const footer = footerIndex >= 0 ? normalized.slice(footerIndex) : '';
  const mainBody = footerIndex >= 0 ? normalized.slice(0, footerIndex) : normalized;
  const suffix = `\n\n${TRUNCATION_NOTICE}${footer}`;
  const budget = Math.max(0, maxChars - suffix.length);
  return `${mainBody.slice(0, budget).trimEnd()}${suffix}`;
}

/** 与既有状态兼容的稳定字符串哈希。 */
export function hashDiscussionReplyBody(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}
