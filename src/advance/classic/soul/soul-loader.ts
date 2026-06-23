/**
 * MR Agent SOUL.md 加载与保存
 *
 * SOUL.md 存放在 CodeKeeper App 存储空间下，避免被误提交到项目仓库：
 * ~/.codekeeper/memory/souls/{projectName}/MR-Agent-SOUL.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectSoulsDir } from '../../../core/platform.js';
import type { Project } from '../../types.js';

export const DEFAULT_SOUL_MD_FILENAME = 'MR-Agent-SOUL.md';

export interface SoulContent {
  content: string;
  sourcePath: string;
}

function getSoulPath(project: Project): string {
  return join(getProjectSoulsDir(project.name), DEFAULT_SOUL_MD_FILENAME);
}

/**
 * 加载项目 MR Agent 的 SOUL.md 配置
 *
 * 从 CodeKeeper App 存储空间读取，不存在时返回 null。
 */
export function loadSoulContent(project: Project): SoulContent | null {
  const path = getSoulPath(project);
  if (!existsSync(path)) {
    return null;
  }
  try {
    return {
      content: readFileSync(path, 'utf-8'),
      sourcePath: path,
    };
  } catch {
    return null;
  }
}

/**
 * 保存 SOUL.md 内容到 CodeKeeper App 存储空间
 */
export function saveSoulContent(project: Project, content: string): string {
  const path = getSoulPath(project);
  mkdirSync(getProjectSoulsDir(project.name), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}
