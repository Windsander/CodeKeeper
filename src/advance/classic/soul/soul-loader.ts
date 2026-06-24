/**
 * MR Agent SOUL.md 加载与保存
 *
 * SOUL.md 存放在 CodeKeeper App 存储空间下，避免被误提交到项目仓库：
 * ~/.codekeeper/memory/souls/{projectName}/{role}-SOUL.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getProjectSoulsDir } from '../../../core/platform.js';
import type { Project, Role } from '../../types.js';

export interface SoulContent {
  content: string;
  sourcePath: string;
}

/**
 * 获取角色对应的 Soul 文件名
 */
export function getSoulFileName(role: Role): string {
  switch (role) {
    case 'reviewer':
      return 'MR-REVIEWER-SOUL.md';
    case 'maintainer':
      return 'MAINTAINER-SOUL.md';
    default:
      throw new Error(`未支持的角色: ${role}`);
  }
}

/**
 * 获取角色 Soul 文件的完整路径
 */
export function getSoulPath(project: Project, role: Role): string {
  const soulsDir = getProjectSoulsDir(project.name);
  return join(soulsDir, getSoulFileName(role));
}

/**
 * 加载指定角色的 Soul 内容
 */
export function loadSoulContent(project: Project, role: Role): SoulContent {
  const sourcePath = getSoulPath(project, role);
  if (!existsSync(sourcePath)) {
    return { content: '', sourcePath };
  }
  try {
    return {
      content: readFileSync(sourcePath, 'utf-8'),
      sourcePath,
    };
  } catch {
    return { content: '', sourcePath };
  }
}

/**
 * 保存指定角色的 Soul 内容
 */
export async function saveSoulContent(
  project: Project,
  role: Role,
  content: string,
): Promise<void> {
  const sourcePath = getSoulPath(project, role);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, content, 'utf-8');
}
