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
 * 从 CodeKeeper App 存储空间读取；文件不存在或读取失败时，仍返回默认保存路径，
 * 以便 UI 在一打开配置面板时就能显示保存位置提示。
 */
export function loadSoulContent(project: Project): SoulContent {
  const path = getSoulPath(project);
  if (!existsSync(path)) {
    return { content: '', sourcePath: path };
  }
  try {
    return {
      content: readFileSync(path, 'utf-8'),
      sourcePath: path,
    };
  } catch {
    return { content: '', sourcePath: path };
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
