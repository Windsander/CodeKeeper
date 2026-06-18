import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SOUL_MD_FILENAME = 'MR-Agent-SOUL.md';

export interface SoulContent {
  content: string;
  sourcePath: string;
}

/**
 * 加载项目 MR Agent 的 SOUL.md 配置
 *
 * 加载优先级：
 * 1. 项目根目录 MR-Agent-SOUL.md
 * 2. 归档目录 MR-Agent-SOUL.md
 * 3. 未找到返回 null
 */
export function loadSoulContent(
  projectRoot: string,
  archiveRoot?: string
): SoulContent | null {
  const candidates = [join(projectRoot, DEFAULT_SOUL_MD_FILENAME)];
  if (archiveRoot) {
    candidates.push(join(archiveRoot, DEFAULT_SOUL_MD_FILENAME));
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return {
        content: readFileSync(path, 'utf-8'),
        sourcePath: path,
      };
    }
  }

  return null;
}
