import { schedule } from 'node-cron';
import type { ProjectRegistry } from './project-registry';
import { FileWatcher } from './file-watcher';
import type { MetadataStore } from './store/metadata-store';
import type { Project, WatchedEvent } from './types';
import { loadProjectConfig } from './config/project-config';

export interface DaemonOptions {
  registry: ProjectRegistry;
  store: MetadataStore;
  /** 全量扫描的 cron 表达式，默认每 5 分钟 */
  scanCron?: string;
}

/**
 * CodeKeeper Advance 守护进程
 */
export class Daemon {
  private watchers = new Map<string, FileWatcher>();
  private scanJob: ReturnType<typeof schedule> | null = null;
  private running = false;

  constructor(private options: DaemonOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    const projects = this.options.registry.list();
    for (const project of projects) {
      this.watchProject(project);
    }

    const cron = this.options.scanCron ?? '*/5 * * * *';
    this.scanJob = schedule(cron, () => this.scanAll());
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.scanJob?.stop();
    this.scanJob = null;
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  private watchProject(project: Project): void {
    if (this.watchers.has(project.id)) return;
    const config = loadProjectConfig(project.rootPath);
    const watcher = new FileWatcher();
    watcher.start({
      projectRoot: project.rootPath,
      config,
      onEvent: (event: WatchedEvent) => {
        this.options.store.insertEvent({ ...event, projectId: project.id });
      },
      onReady: () => {
        // watcher 已就绪，确保 chokidar 完成初始扫描
      },
    });
    this.watchers.set(project.id, watcher);
  }

  private scanAll(): void {
    const projects = this.options.registry.list();
    for (const project of projects) {
      this.options.store.updateLastScannedAt(project.id, Date.now());
      // TODO: Phase 2 实现全量目录扫描与 LLM 归档
    }
  }
}
