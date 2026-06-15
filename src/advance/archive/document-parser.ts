import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

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
  /** 文件语言/类型，用于下游分类与展示 */
  language?: string;
}

export interface ParseOptions {
  /** 最大读取字符数（按 JavaScript 字符串长度计算），默认 10000 */
  maxLength?: number;
  /** 文件编码，默认 utf-8 */
  encoding?: BufferEncoding;
}

/**
 * 支持的文本文件扩展名到语言标识的映射
 * 不在此列表中的文件被视为二进制或无需解析的类型
 */
export const SUPPORTED_TEXT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.md', 'markdown'],
  ['.mdx', 'markdown'],
  ['.txt', 'text'],
  ['.json', 'json'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.toml', 'toml'],
  ['.ini', 'ini'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.swift', 'swift'],
  ['.c', 'c'],
  ['.cpp', 'cpp'],
  ['.h', 'c'],
  ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.php', 'php'],
  ['.rb', 'ruby'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.ps1', 'powershell'],
  ['.sql', 'sql'],
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.less', 'less'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.xml', 'xml'],
  ['.svg', 'svg'],
  ['.dockerfile', 'dockerfile'],
]);

/**
 * 判断文件是否支持文本解析
 */
export function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (SUPPORTED_TEXT_EXTENSIONS.has(ext)) return true;
  // 无扩展名文件尝试读取并检测 null 字节
  if (ext === '') {
    try {
      const sample = readFileSync(filePath).slice(0, 1024);
      return !sample.includes(0);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 解析单个文档，返回内容与元数据
 * 对不支持的二进制文件抛出错误
 */
export function parseDocument(filePath: string, options: ParseOptions = {}): ParsedDocument {
  if (!isTextFile(filePath)) {
    throw new Error(`不支持的文件类型：${filePath}`);
  }

  const maxLength = options.maxLength ?? 10000;
  const encoding = options.encoding ?? 'utf-8';
  const language = SUPPORTED_TEXT_EXTENSIONS.get(extname(filePath).toLowerCase());

  const stat = statSync(filePath);
  const full = readFileSync(filePath, encoding);
  const truncated = full.length > maxLength;
  const content = truncated ? full.slice(0, maxLength) : full;

  const hash = createHash('sha256').update(full).digest('hex').slice(0, 16);

  return {
    filePath,
    content,
    contentHash: hash,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    truncated,
    language,
  };
}
