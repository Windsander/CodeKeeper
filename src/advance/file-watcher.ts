import { watch, type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import type { ProjectConfig } from './config/project-config';
import type { WatchedEvent, WatchEventType } from './types';
import { logger } from '../core/logger';

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

    const isExcluded = (filePath: string): boolean => {
      const normalized = filePath.replace(/\\/g, '/');
      return config.exclude.some((pattern) => minimatch(normalized, pattern, { dot: true }));
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

    const emit = (type: WatchEventType, filePath: string) => {
      const absolutePath = join(projectRoot, filePath).replace(/\\/g, '/');
      if (isExcluded(absolutePath)) {
        logger.debug({ filePath: absolutePath }, '忽略被排除的文件事件');
        return;
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
