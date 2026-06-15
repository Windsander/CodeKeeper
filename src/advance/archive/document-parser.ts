import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface ParsedDocument {
  /** 文件绝对路径 */
  filePath: string;
  /** 文件内容（文本） */
  content: string;
  /** 内容 sha256 前 16 位 */
  contentHash: string;
  /** 文件大小字节 */
  size: number;
  /** 最后修改时间 */
  modifiedAt: number;
  /** 是否被截断 */
  truncated: boolean;
}

export interface ParseOptions {
  /** 最大读取字符数，默认 10000 */
  maxLength?: number;
  /** 文件编码，默认 utf-8 */
  encoding?: BufferEncoding;
}

/**
 * 解析单个文档，返回内容与元数据
 */
export function parseDocument(filePath: string, options: ParseOptions = {}): ParsedDocument {
  const maxLength = options.maxLength ?? 10000;
  const encoding = options.encoding ?? 'utf-8';

  const stat = statSync(filePath);
  const full = readFileSync(filePath, encoding);
  const truncated = full.length > maxLength;
  const content = truncated ? full.slice(0, maxLength) : full;

  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);

  return {
    filePath,
    content,
    contentHash: hash,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    truncated,
  };
}
