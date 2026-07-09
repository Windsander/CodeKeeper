/**
 * 流式聚焦上下文构建器
 *
 * 把 StreamingFileReader 的窗口结果转成 FocusedContext，
 * 供 MaintainerBrain / CognitiveEngine 直接使用。
 */

import type { ReviewFinding } from '../provider/types.js';
import type { FocusedContext, FocusedContextOptions } from './focused-context-builder.js';
import { readWindow, type FileWindowResult } from '../worktree/streaming-file-reader.js';

/**
 * 基于流式窗口读取构建 FocusedContext
 */
export async function buildFocusedContextStreamed(
  filePath: string,
  finding: ReviewFinding,
  options?: FocusedContextOptions
): Promise<FocusedContext> {
  const padding = options?.padding ?? 25;
  const maxLines = options?.maxLines ?? 80;
  const windowResult = await readWindow(filePath, {
    targetLine: finding.line,
    padding,
    maxLines,
  });
  return fileWindowResultToFocusedContext(windowResult, finding);
}

/**
 * 把 FileWindowResult 转成 FocusedContext
 */
export function fileWindowResultToFocusedContext(
  result: FileWindowResult,
  finding: ReviewFinding
): FocusedContext {
  return {
    imports: result.imports,
    snippet: result.content,
    snippetStartLine: result.startLine,
    snippetEndLine: result.endLine,
    totalLines: result.totalLines,
    truncated: result.isPartial,
    targetLine: finding.line,
  };
}

/**
 * 把 FocusedContext 还原成可塞进 prompt 的字符串
 */
export function focusedContextToString(context: FocusedContext): string {
  const parts: string[] = [];
  if (context.imports?.trim()) {
    parts.push(context.imports);
  }
  parts.push(context.snippet);
  return parts.join('\n\n');
}
