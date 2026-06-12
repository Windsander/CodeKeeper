import { watch, type FSWatcher } from 'chokidar';
import type { ProjectConfig } from './config/project-config';
import type { WatchedEvent, WatchEventType } from './types';

export interface FileWatcherOptions {
  projectRoot: string;
  config: ProjectConfig;
  onEvent: (event: WatchedEvent) => void;
}

/**
 * 基于 chokidar 的文件监听器
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;

  start(options: FileWatcherOptions): void {
    const { projectRoot, config, onEvent } = options;
    this.watcher = watch(config.include, {
      cwd: projectRoot,
      ignored: config.exclude,
      ignoreInitial: true,
      persistent: true,
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
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
