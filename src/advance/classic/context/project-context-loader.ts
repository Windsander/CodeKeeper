import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_LENGTH = 3000;

/**
 * 加载项目自动归纳的智库内容
 *
 * 默认读取归档目录中的 context.md，截取前 N 个字符作为 prompt 上下文。
 * 若文件不存在或为空，返回空字符串。
 */
export function loadProjectContext(
  archiveRoot: string,
  maxLength = DEFAULT_MAX_LENGTH
): string {
  const path = join(archiveRoot, 'context.md');
  if (!existsSync(path)) {
    return '';
  }
  const content = readFileSync(path, 'utf-8').trim();
  if (!content) {
    return '';
  }
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + '\n...（智库内容已截断）';
}
