/**
 * 流式文件窗口读取器
 *
 * 基于 createReadStream + readline 实现，只加载目标行范围，
 * 避免一次性把超大文件完整读入堆内存。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * 流式文件窗口读取结果
 */
export interface FileWindowResult {
  /** 窗口或范围内容 */
  content: string;
  /** 内容起始行号（1-based） */
  startLine: number;
  /** 内容结束行号（1-based） */
  endLine: number;
  /** 文件总行数 */
  totalLines: number;
  /** 是否只是文件的一部分 */
  isPartial: boolean;
  /** 顶部 import / shebang / 文件头注释区文本 */
  imports: string;
}

/**
 * 窗口读取选项
 */
export interface ReadWindowOptions {
  /** 目标行号（1-based） */
  targetLine: number;
  /** 目标行前后保留行数，默认 25 */
  padding?: number;
  /** 最大返回行数，默认 80 */
  maxLines?: number;
}

/**
 * 判断一行是否属于文件头部（import / shebang / 顶部注释）
 */
function isHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#')
  ) {
    return true;
  }
  if (trimmed.startsWith('import ')) return true;
  if (trimmed.startsWith('require(')) return true;
  if (trimmed.startsWith('const ') && trimmed.includes(' = require(')) return true;
  return false;
}

/**
 * 统计文件总行数
 */
export async function countLines(filePath: string): Promise<number> {
  let total = 0;
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const _ of rl) {
    total++;
  }
  return total;
}

/**
 * 读取顶部 import / shebang / 文件头注释区
 */
export async function readImports(filePath: string): Promise<string> {
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    if (isHeaderLine(rawLine)) {
      lines.push(rawLine);
    } else {
      break;
    }
  }
  return lines.join('\n');
}

/**
 * 读取任意连续行范围
 */
export async function readRange(
  filePath: string,
  startLine: number,
  endLine: number
): Promise<FileWindowResult> {
  const lines: string[] = [];
  let totalLines = 0;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    totalLines++;
    if (totalLines >= startLine && totalLines <= endLine) {
      lines.push(rawLine);
    }
    if (totalLines >= endLine) {
      break;
    }
  }

  const actualEnd = Math.min(totalLines, endLine);
  const actualStart = Math.min(startLine, actualEnd);
  const isPartial = totalLines > actualEnd || actualStart > 1;

  return {
    content: lines.join('\n'),
    startLine: actualStart,
    endLine: actualEnd,
    totalLines,
    isPartial,
    imports: '',
  };
}

/**
 * 读取目标行周围的窗口，并附带顶部 import 区
 */
export async function readWindow(
  filePath: string,
  options: ReadWindowOptions
): Promise<FileWindowResult> {
  const { targetLine, padding = 25, maxLines = 80 } = options;
  const importLines: string[] = [];
  const windowLines: string[] = [];
  let totalLines = 0;
  let inHeader = true;

  const rawStartLine = Math.max(1, targetLine - padding);
  const rawEndLine = targetLine + padding;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    totalLines++;
    if (inHeader) {
      if (isHeaderLine(rawLine)) {
        importLines.push(rawLine);
      } else {
        inHeader = false;
      }
    }
    if (totalLines >= rawStartLine && totalLines <= rawEndLine) {
      windowLines.push(rawLine);
    }
  }

  let startLine = rawStartLine;
  let endLine = Math.min(totalLines, rawEndLine);

  // 如果窗口超过 maxLines，以 targetLine 为中心二次读取精确范围
  if (windowLines.length > maxLines) {
    const half = Math.floor(maxLines / 2);
    startLine = Math.max(1, targetLine - half);
    endLine = Math.min(totalLines, startLine + maxLines - 1);
    startLine = Math.max(1, endLine - maxLines + 1);
    const rangeResult = await readRange(filePath, startLine, endLine);
    return {
      ...rangeResult,
      imports: importLines.join('\n'),
      totalLines,
      isPartial: true,
    };
  }

  const isPartial = totalLines > endLine || startLine > 1;

  return {
    content: windowLines.join('\n'),
    startLine,
    endLine,
    totalLines,
    isPartial,
    imports: importLines.join('\n'),
  };
}
