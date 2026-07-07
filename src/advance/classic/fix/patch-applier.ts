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
 */
export function applyPatch(originalContent: string, filePatch: FilePatch): ApplyResult {
  const { lines, endsWithNewline } = splitContent(originalContent);
  let offset = 0;
  const result = [...lines];

  for (let hunkIndex = 0; hunkIndex < filePatch.hunks.length; hunkIndex++) {
    const hunk = filePatch.hunks[hunkIndex];
    const expectedStart = hunk.oldStart + offset - 1;

    if (expectedStart < 0 || expectedStart + hunk.oldLines > result.length) {
      return {
        success: false,
        conflict: {
          filePath: filePatch.newPath,
          hunkIndex,
          expectedLine: hunk.oldStart,
          reason: `hunk 目标行范围超出文件边界 (expected ${expectedStart + 1}, 文件共 ${result.length} 行)`,
        },
      };
    }

    const expectedLines = hunk.lines.filter((l) => l.type !== 'add').map((l) => l.content);
    for (let i = 0; i < hunk.oldLines; i++) {
      if (result[expectedStart + i] !== expectedLines[i]) {
        return {
          success: false,
          conflict: {
            filePath: filePatch.newPath,
            hunkIndex,
            expectedLine: hunk.oldStart + i,
            reason: `上下文不匹配：期望 "${expectedLines[i]}", 实际 "${result[expectedStart + i]}"`,
          },
        };
      }
    }

    const replacement = hunk.lines.filter((l) => l.type !== 'remove').map((l) => l.content);
    result.splice(expectedStart, hunk.oldLines, ...replacement);
    offset += replacement.length - hunk.oldLines;
  }

  return {
    success: true,
    content: joinContent(result, endsWithNewline),
  };
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
