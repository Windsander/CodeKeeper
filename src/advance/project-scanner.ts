import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { minimatch } from 'minimatch';
import type { MetadataStore } from './store/metadata-store';
import type { Project } from './types';
import type { ProjectConfig } from './config/project-config';

/**
 * 扫描项目根目录下所有现有文件，将符合 include/exclude 规则的文件作为 'add' 事件入库
 */
export function scanExistingFiles(
  store: MetadataStore,
  project: Project,
  config: ProjectConfig
): number {
  const matched: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry).replace(/\\/g, '/');
      const relPath = relative(project.rootPath, fullPath).replace(/\\/g, '/');

      // 排除规则优先
      if (config.exclude.some((pattern) => minimatch(relPath, pattern, { dot: true }))) {
        continue;
      }

      let isDirectory = false;
      try {
        isDirectory = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }

      if (isDirectory) {
        walk(fullPath);
      } else if (config.include.some((pattern) => minimatch(relPath, pattern, { dot: true }))) {
        matched.push(fullPath);
      }
    }
  }

  walk(project.rootPath.replace(/\\/g, '/'));

  const now = Date.now();
  for (const filePath of matched) {
    store.insertEvent({
      projectId: project.id,
      type: 'add',
      filePath,
      timestamp: now,
    });
  }

  return matched.length;
}
