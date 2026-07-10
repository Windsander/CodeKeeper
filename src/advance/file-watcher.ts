import { watch, type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import type { ProjectConfig } from './config/project-config';
import type { WatchedEvent, WatchEventType } from './types';
import { logger } from '../core/logger';
import { logMemorySnapshot } from './classic/utils/memory-snapshot.js';

export interface FileWatcherOptions {
  projectRoot: string;
  config: ProjectConfig;
  onEvent: (event: WatchedEvent) => void;
  onReady?: () => void;
  onError?: (err: Error) => void;
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  } catch {
    return false;
  }
}

/**
 * 基于 chokidar 的文件监听器
 *
 * WSL 环境下默认启用 polling 模式（因为跨文件系统挂载时 inotify 不可靠），
 * 但 interval 设置得较大，避免初始化扫描时阻塞 daemon 的事件循环。
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;

  start(options: FileWatcherOptions): void {
    const { projectRoot, config, onEvent, onReady, onError } = options;
    const normalizedProjectRoot = projectRoot.replace(/\\/g, '/');

    const isExcluded = (filePath: string): boolean => {
      const normalized = filePath.replace(/\\/g, '/');
      // chokidar 在某些场景下会传绝对路径，排除模式又是相对路径，需要先换算成相对路径
      const rel = normalized.startsWith(normalizedProjectRoot)
        ? normalized.slice(normalizedProjectRoot.length).replace(/^\//, '')
        : normalized;
      return config.exclude.some((pattern) => minimatch(rel, pattern, { dot: true }));
    };

    const usePolling = isWsl();
    this.watcher = watch(projectRoot, {
      cwd: projectRoot,
      ignored: (filePath: string) => isExcluded(filePath),
      ignoreInitial: true,
      persistent: true,
      usePolling,
      interval: usePolling ? 2000 : undefined,
      binaryInterval: usePolling ? 2000 : undefined,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: usePolling ? 2000 : 100,
      },
    });

    logger.info({ projectRoot }, '文件监控已启动');

    let eventCount = 0;
    const logEventMemoryThreshold = 500 * 1024 * 1024;

    const emit = (type: WatchEventType, filePath: string) => {
      // filePath 来自 chokidar，此时是相对于 projectRoot 的路径
      if (isExcluded(filePath)) {
        logger.debug({ filePath }, '忽略被排除的文件事件');
        return;
      }
      const absolutePath = join(projectRoot, filePath).replace(/\\/g, '/');
      eventCount++;
      if (eventCount % 50 === 0 || process.memoryUsage().heapUsed > logEventMemoryThreshold) {
        logMemorySnapshot(`FileWatcher 已处理 ${eventCount} 个事件`);
      }
      logger.info({ type, filePath: absolutePath }, '收到文件变更事件');
      onEvent({
        type,
        filePath: absolutePath,
        timestamp: Date.now(),
      });
    };

    this.watcher
      .on('add', (path) => emit('add', path))
      .on('change', (path) => emit('change', path))
      .on('unlink', (path) => emit('unlink', path));

    if (onReady) {
      this.watcher.on('ready', onReady);
    }
    if (onError) {
      this.watcher.on('error', (err: unknown) => onError(err instanceof Error ? err : new Error(String(err))));
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
