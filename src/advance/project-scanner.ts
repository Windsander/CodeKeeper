import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { MetadataStore } from './store/metadata-store';
import type { Project } from './types';
import { matchesProjectPathPatterns, type ProjectConfig } from './config/project-config';

/**
 * 让出事件循环，避免长时间同步 IO 阻塞 daemon 的 IPC/定时任务
 */
async function yieldEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * 异步扫描项目根目录下所有现有文件，将符合 include/exclude 规则的文件作为 'add' 事件入库
 *
 * 每次读取一个目录后都会让出事件循环，保证大项目扫描时 daemon 仍能响应 IPC 请求。
 */
export async function scanExistingFiles(
  store: MetadataStore,
  project: Project,
  config: ProjectConfig
): Promise<number> {
  // 已跟踪的文件路径集合：pending 事件 + 已处理条目，避免重复生成事件
  const tracked = new Set<string>([
    ...store.listPendingEventPaths(project.id),
    ...store.listEntryPaths(project.id),
  ]);

  const matched: string[] = [];
  let scannedCount = 0;

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    // 每读完一个目录就让出事件循环，避免阻塞 IPC
    await yieldEventLoop();

    for (const entry of entries) {
      const fullPath = join(dir, entry).replace(/\\/g, '/');
      const relPath = relative(project.rootPath, fullPath).replace(/\\/g, '/');

      // 排除规则优先
      if (matchesProjectPathPatterns(relPath, config.exclude)) {
        continue;
      }

      let isDirectory = false;
      try {
        isDirectory = (await stat(fullPath)).isDirectory();
      } catch {
        continue;
      }

      if (isDirectory) {
        await walk(fullPath);
      } else if (matchesProjectPathPatterns(relPath, config.include)) {
        if (!tracked.has(fullPath)) {
          matched.push(fullPath);
        }
      }

      // 每扫描 50 个文件项让出一次事件循环，降低大目录扫描对 IPC 的占用
      scannedCount += 1;
      if (scannedCount % 50 === 0) {
        await yieldEventLoop();
      }
    }
  }

  await walk(project.rootPath.replace(/\\/g, '/'));

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
