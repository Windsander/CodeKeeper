/**
 * 最小 unified diff 解析与 patch 应用器
 *
 * 不依赖外部 diff 库，支持标准 diff 格式、多 hunk、冲突检测。
 */

export interface HunkLine {
  type: 'context' | 'add' | 'remove';
  /** 原始行内容，不含 +/- 前缀 */
  content: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

export interface ApplyResult {
  success: boolean;
  /** 应用成功后的完整文件内容 */
  content?: string;
  /** 应用失败时的冲突信息 */
  conflict?: {
    filePath: string;
    hunkIndex: number;
    expectedLine: number;
    reason: string;
  };
}

const DIFF_HEADER_REGEX = /^diff --git\s+(.+)\s+(.+)$/;
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * 将统一 diff 文本解析为 FilePatch 数组
 */
export function parsePatch(unifiedDiff: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const lines = splitIntoLines(unifiedDiff);

  let current: FilePatch | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const diffMatch = line.match(DIFF_HEADER_REGEX);
    if (diffMatch) {
      if (current) {
        patches.push(current);
      }
      current = {
        oldPath: extractPath(diffMatch[1]),
        newPath: extractPath(diffMatch[2]),
        hunks: [],
      };
      continue;
    }

    // 兼容 LLM 省略 diff --git 头、直接输出 --- / +++ / @@ 的情况
    if (line.startsWith('--- ')) {
      if (current && current.hunks.length > 0) {
        patches.push(current);
        current = null;
      }
      if (!current) {
        current = {
          oldPath: extractPath(line.slice(4).trim()),
          newPath: extractPath(line.slice(4).trim()),
          hunks: [],
        };
      } else {
        current.oldPath = extractPath(line.slice(4).trim());
      }
      continue;
    }

    if (!current) continue;

    if (line.startsWith('--- ')) {
      current.oldPath = extractPath(line.slice(4).trim());
      continue;
    }

    if (line.startsWith('+++ ')) {
      current.newPath = extractPath(line.slice(4).trim());
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      current.hunks.push({
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newLines: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      });
      continue;
    }

    // "\\ No newline at end of file" 跳过
    if (line === '\\' || line.startsWith('\\ ')) {
      continue;
    }

    const lastHunk = current.hunks[current.hunks.length - 1];
    if (!lastHunk) continue;

    if (line.startsWith(' ')) {
      lastHunk.lines.push({ type: 'context', content: line.slice(1) });
    } else if (line.startsWith('+')) {
      lastHunk.lines.push({ type: 'add', content: line.slice(1) });
    } else if (line.startsWith('-')) {
      lastHunk.lines.push({ type: 'remove', content: line.slice(1) });
    }
  }

  if (current) {
    patches.push(current);
  }

  return patches;
}

/**
 * 把单个 FilePatch 应用到原始文件内容
 *
 * 采用“上下文优先、行号为 hint”的策略：先按 hunk.oldStart 尝试精确匹配，
 * 失败后在附近窗口内搜索上下文行，提升对 LLM 生成 patch 的容错能力。
 */
export function applyPatch(originalContent: string, filePatch: FilePatch): ApplyResult {
  const { lines, endsWithNewline } = splitContent(originalContent);
  let offset = 0;
  const result = [...lines];

  for (let hunkIndex = 0; hunkIndex < filePatch.hunks.length; hunkIndex++) {
    const hunk = filePatch.hunks[hunkIndex];
    const pos = findHunkPosition(result, hunk, hunk.oldStart + offset - 1);

    if (pos < 0) {
      return {
        success: false,
        conflict: {
          filePath: filePatch.newPath,
          hunkIndex,
          expectedLine: hunk.oldStart,
          reason: '无法在文件中找到匹配的上下文',
        },
      };
    }

    const oldLines = hunk.lines.filter((l) => l.type !== 'add').map((l) => l.content);
    const replacement = hunk.lines.filter((l) => l.type !== 'remove').map((l) => l.content);
    result.splice(pos, oldLines.length, ...replacement);
    offset += replacement.length - oldLines.length;
  }

  return {
    success: true,
    content: joinContent(result, endsWithNewline),
  };
}

/**
 * 在文件行数组中定位 hunk 可应用的位置。
 *
 * 优先使用 hintIndex（hunk.oldStart 对应 0-based 索引），在其周围窗口搜索；
 * 找不到时再全文件搜索。返回匹配起始索引，找不到返回 -1。
 */
function findHunkPosition(
  fileLines: string[],
  hunk: Hunk,
  hintIndex: number,
  windowSize = 20
): number {
  const oldLines = hunk.lines.filter((l) => l.type !== 'add').map((l) => l.content);
  if (oldLines.length === 0) {
    // 没有旧内容需要匹配时，直接返回 hint
    return Math.max(0, Math.min(hintIndex, fileLines.length));
  }

  const searchStart = Math.max(0, hintIndex - windowSize);
  const searchEnd = Math.min(fileLines.length - oldLines.length, hintIndex + windowSize);

  for (let start = searchStart; start <= searchEnd; start++) {
    if (matchOldLines(fileLines, start, oldLines)) {
      return start;
    }
  }

  // 窗口内未命中，尝试全文件搜索
  for (let start = 0; start <= fileLines.length - oldLines.length; start++) {
    if (start >= searchStart && start <= searchEnd) continue;
    if (matchOldLines(fileLines, start, oldLines)) {
      return start;
    }
  }

  return -1;
}

function matchOldLines(fileLines: string[], start: number, oldLines: string[]): boolean {
  for (let i = 0; i < oldLines.length; i++) {
    if (fileLines[start + i] !== oldLines[i]) {
      return false;
    }
  }
  return true;
}

/**
 * 连续应用多个 FilePatch（通常用于同一文件的多段补丁）
 */
export function applyPatches(originalContent: string, filePatches: FilePatch[]): ApplyResult {
  let current = originalContent;
  for (const patch of filePatches) {
    const res = applyPatch(current, patch);
    if (!res.success || res.content === undefined) {
      return res;
    }
    current = res.content;
  }
  return { success: true, content: current };
}

function extractPath(raw: string): string {
  // 去掉 a/ 或 b/ 前缀以及 " 索引等
  return raw.replace(/^(a|b)\//, '').split('\t')[0];
}

function splitIntoLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
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

function joinContent(lines: string[], endsWithNewline: boolean): string {
  return lines.join('\n') + (endsWithNewline ? '\n' : '');
}
