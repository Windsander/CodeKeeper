import { statSync, openSync, closeSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

export interface FileMetadata {
  /** 源文件绝对路径 */
  sourcePath: string;
  /** 文件名 */
  fileName: string;
  /** 扩展名（小写） */
  extension: string;
  /** 文件大小字节 */
  size: number;
  /** 最后修改时间戳 */
  modifiedAt: number;
  /** 前 500 字节文本头 */
  header: string;
  /** header 的 sha256 前缀 */
  headerHash: string;
  /** 路径分词 */
  pathTokens: string[];
  /** 从文件名/路径提取的日期线索 */
  dateHints: string[];
  /** 路径启发分类 */
  estimatedCategory?: string;
  /** 路径启发文档类型 */
  estimatedDocType?: string;
  /** 启发置信度 0-1 */
  heuristicConfidence: number;
}

/**
 * 从文件路径与基本元数据提取信息，尽量不读取完整内容
 */
export function extractMetadata(sourcePath: string): FileMetadata {
  const fileName = basename(sourcePath);
  const extension = extname(sourcePath).toLowerCase();
  const stat = statSync(sourcePath);
  const header = readHeader(sourcePath, 500);
  const headerHash = createHash('sha256').update(header).digest('hex').slice(0, 16);
  const pathTokens = tokenizePath(sourcePath);
  const dateHints = extractDateHints(fileName, pathTokens);
  const estimate = classifyByPath(sourcePath, fileName, pathTokens);

  return {
    sourcePath,
    fileName,
    extension,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    header,
    headerHash,
    pathTokens,
    dateHints,
    estimatedCategory: estimate.category,
    estimatedDocType: estimate.docType,
    heuristicConfidence: estimate.confidence,
  };
}

function readHeader(filePath: string, maxBytes: number): string {
  try {
    const fd = openFile(filePath);
    if (!fd) return '';
    const buffer = Buffer.alloc(maxBytes);
    const read = fd.read(buffer, 0, maxBytes, 0);
    fd.close();
    const slice = read.bytesRead > 0 ? buffer.slice(0, read.bytesRead) : buffer;
    // 去除 null 字节，避免二进制文件干扰
    const text = slice.toString('utf-8').replace(/\0/g, '');
    return text;
  } catch {
    return '';
  }
}

function openFile(filePath: string): { read: (b: Buffer, o: number, l: number, p: number) => { bytesRead: number }; close: () => void } | null {
  try {
    const fd = openSync(filePath, 'r');
    return {
      read: (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = readSync(fd, buffer, { offset, length, position });
        return { bytesRead };
      },
      close: () => closeSync(fd),
    };
  } catch {
    return null;
  }
}

function tokenizePath(filePath: string): string[] {
  const parts = filePath.split(/[/\\_-]+/);
  return parts
    .map((p) => p.toLowerCase().replace(/\.[^.]+$/, ''))
    .filter((p) => p.length > 1 && !/^[0-9]+$/.test(p));
}

function extractDateHints(fileName: string, _tokens: string[]): string[] {
  const hints: string[] = [];
  const datePattern = /(\d{4})[-_./]?(\d{1,2})/g;
  let m: RegExpExecArray | null;
  while ((m = datePattern.exec(fileName)) !== null) {
    const [year, month] = [m[1], m[2].padStart(2, '0')];
    if (Number(year) >= 2000 && Number(year) <= 2100 && Number(month) >= 1 && Number(month) <= 12) {
      hints.push(`${year}-${month}`);
    }
  }
  return [...new Set(hints)];
}

interface HeuristicResult {
  category?: string;
  docType?: string;
  confidence: number;
}

function classifyByPath(filePath: string, fileName: string, _tokens: string[]): HeuristicResult {
  const lowerPath = filePath.toLowerCase();
  const lowerName = fileName.toLowerCase();

  // 路径匹配
  if (lowerPath.includes('weekly') || lowerName.includes('weekly')) {
    return { category: 'weekly', docType: 'weekly', confidence: 0.9 };
  }
  if (lowerPath.includes('/docs/design') || lowerPath.includes('\\docs\\design') || lowerPath.includes('/design/')) {
    return { category: 'design', docType: 'design', confidence: 0.85 };
  }
  if (lowerPath.includes('/docs/spec') || lowerPath.includes('\\docs\\spec') || lowerName.includes('spec')) {
    return { category: 'design', docType: 'spec', confidence: 0.8 };
  }
  if (lowerPath.includes('memory')) {
    return { category: 'memory', docType: 'note', confidence: 0.75 };
  }
  if (lowerPath.includes('review') || lowerName.includes('review')) {
    return { category: 'review', docType: 'review', confidence: 0.8 };
  }
  if (lowerPath.includes('skill')) {
    return { category: 'skill', docType: 'note', confidence: 0.7 };
  }
  if (lowerName.includes('readme')) {
    return { category: 'other', docType: 'note', confidence: 0.8 };
  }
  if (lowerName.endsWith('.config.md') || lowerName.endsWith('.config.txt')) {
    return { category: 'other', docType: 'config', confidence: 0.75 };
  }

  // 文件名关键字匹配
  if (lowerName.includes('bug') || lowerName.includes('issue')) {
    return { category: 'review', docType: 'note', confidence: 0.6 };
  }

  return { confidence: 0.0 };
}
