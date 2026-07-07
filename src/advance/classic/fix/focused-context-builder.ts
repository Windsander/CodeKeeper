/**
 * 聚焦上下文构建器
 *
 * 从整文件内容中提取与 finding 相关的代码片段和 import 区，
 * 避免把整份文件（或截断后的 80 行）直接塞进 LLM prompt。
 */

import type { ReviewFinding } from '../provider/types.js';

export interface FocusedContext {
  /** 文件顶部导入区文本 */
  imports: string;
  /** 聚焦代码片段文本 */
  snippet: string;
  /** 片段在文件中的起始行号（1-based） */
  snippetStartLine: number;
  /** 片段在文件中的结束行号（1-based） */
  snippetEndLine: number;
  /** 原始文件总行数 */
  totalLines: number;
  /** 是否被截断 */
  truncated: boolean;
  /** finding 所在行 */
  targetLine: number;
}

export interface FocusedContextOptions {
  /** finding 前后保留行数，默认 25 */
  padding?: number;
  /** 最大片段行数上限，默认 80 */
  maxLines?: number;
  /** 是否尝试扩展到函数/类边界（遇到空行停止），默认 true */
  expandToBoundary?: boolean;
}

/**
 * 从整文件内容中提取聚焦上下文
 */
export function buildFocusedContext(
  fileContent: string,
  finding: ReviewFinding,
  options?: FocusedContextOptions
): FocusedContext {
  const padding = options?.padding ?? 25;
  const maxLines = options?.maxLines ?? 80;
  const expandToBoundary = options?.expandToBoundary ?? true;

  const { lines, endsWithNewline } = splitContent(fileContent);
  const totalLines = lines.length;
  const targetLine = Math.max(1, Math.min(finding.line, totalLines || 1));

  const importEndLine = trimTrailingBlankLines(extractImportEndLine(lines), lines);

  let startLine = Math.max(importEndLine + 1, targetLine - padding);
  let endLine = Math.min(totalLines, targetLine + padding);

  if (expandToBoundary) {
    // 向上扩展到空行或 import 区边界
    while (startLine > importEndLine + 1) {
      const prev = lines[startLine - 2];
      if (prev === undefined || prev.trim() === '') break;
      startLine--;
    }
    // 向下扩展到空行或文件末尾
    while (endLine < totalLines) {
      const next = lines[endLine];
      if (next === undefined || next.trim() === '') break;
      endLine++;
    }
  }

  let truncated = false;
  if (endLine - startLine + 1 > maxLines) {
    // 以 targetLine 为中心截断到 maxLines
    startLine = Math.max(importEndLine + 1, targetLine - Math.floor(maxLines / 2));
    endLine = Math.min(totalLines, startLine + maxLines - 1);
    startLine = Math.max(importEndLine + 1, endLine - maxLines + 1);
    truncated = true;
  }

  const imports = lines.slice(0, importEndLine).join('\n');
  const snippet = lines.slice(startLine - 1, endLine).join('\n');

  // 如果文件原本以换行结尾，且片段不是到文件末尾，保持格式提示
  const snippetEndsWithNewline = endsWithNewline && endLine === totalLines;

  return {
    imports,
    snippet: snippetEndsWithNewline ? snippet + '\n' : snippet,
    snippetStartLine: startLine,
    snippetEndLine: endLine,
    totalLines,
    truncated,
    targetLine,
  };
}

/**
 * 找到导入区结束行号（0-based，表示 imports 占用了 lines[0..importEndLine-1]）
 */
function extractImportEndLine(lines: string[]): number {
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (isImportOrRequire(line)) continue;
    // 允许顶部的 shebang / 注释出现在 import 之前
    if (
      line.trim().startsWith('//') ||
      line.trim().startsWith('/*') ||
      line.trim().startsWith('*') ||
      line.trim().startsWith('#')
    ) {
      continue;
    }
    break;
  }
  return i;
}

function trimTrailingBlankLines(endLine: number, lines: string[]): number {
  while (endLine > 0 && lines[endLine - 1].trim() === '') {
    endLine--;
  }
  return endLine;
}

function isImportOrRequire(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('import ') ||
    trimmed.startsWith('require(') ||
    trimmed.startsWith('const ') && trimmed.includes(' = require(')
  );
}

function splitContent(content: string): { lines: string[]; endsWithNewline: boolean } {
  const normalized = content.replace(/\r\n/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) {
    lines.pop();
  }
  return { lines, endsWithNewline };
}
