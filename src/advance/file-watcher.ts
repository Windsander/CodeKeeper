import { watch, type FSWatcher } from 'chokidar';
import { existsSync } from 'node:fs';
import type { ProjectConfig } from './config/project-config';
import type { WatchedEvent, WatchEventType } from './types';

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
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;

  start(options: FileWatcherOptions): void {
    const { projectRoot, config, onEvent, onReady, onError } = options;
    this.watcher = watch(projectRoot, {
      cwd: projectRoot,
      ignored: config.exclude,
      ignoreInitial: true,
      persistent: true,
      usePolling: isWsl(),
      interval: isWsl() ? 100 : undefined,
    });

    const emit = (type: WatchEventType, filePath: string) => {
      onEvent({
        type,
        filePath,
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
