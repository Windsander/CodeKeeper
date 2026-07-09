/**
 * 文件概览构建器
 *
 * 流式扫描文件，给出总行数和轻量级顶层符号列表。
 * 不使用 AST，避免大文件二次解析开销。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * 文件符号条目
 */
export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'method' | 'export' | 'other';
  startLine: number;
  endLine?: number;
}

/**
 * 文件概览
 */
export interface FileOverview {
  /** 文件总行数 */
  lineCount: number;
  /** 扫描到的顶层符号列表 */
  symbols: SymbolEntry[];
}

/**
 * 符号识别规则，按语言扩展
 */
const SYMBOL_PATTERNS: Array<{ kind: SymbolEntry['kind']; regex: RegExp } > = [
  { kind: 'function', regex: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'class', regex: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', regex: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', regex: /^def\s+([A-Za-z_][\w]*)\s*\(/ },
  { kind: 'function', regex: /^func\s+([A-Za-z_][\w]*)\s*\(/ },
  { kind: 'class', regex: /^class\s+([A-Za-z_][\w]*)/ },
];

export interface BuildOverviewOptions {
  /** 最多扫描多少行用于符号识别，默认 2000 */
  maxScanLines?: number;
}

/**
 * 为指定文件构建轻量级概览
 */
export async function buildFileOverview(
  filePath: string,
  options?: BuildOverviewOptions
): Promise<FileOverview> {
  const maxScanLines = options?.maxScanLines ?? 2000;
  const symbols: SymbolEntry[] = [];
  let lineCount = 0;
  let scanning = true;

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    lineCount++;
    if (!scanning) continue;
    if (lineCount > maxScanLines) {
      scanning = false;
      continue;
    }

    const trimmed = rawLine.trim();
    for (const pattern of SYMBOL_PATTERNS) {
      const match = trimmed.match(pattern.regex);
      if (match) {
        symbols.push({
          name: match[1],
          kind: pattern.kind,
          startLine: lineCount,
        });
        break;
      }
    }
  }

  return { lineCount, symbols };
}
