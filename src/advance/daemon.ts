import { schedule } from 'node-cron';
import type { ProjectRegistry } from './project-registry';
import { FileWatcher } from './file-watcher';
import type { MetadataStore } from './store/metadata-store';
import type { Project, WatchedEvent } from './types';
import { loadProjectConfig } from './config/project-config';
import { saveDaemonConfig } from './config/daemon-config';
import { ArchivePipeline } from './pipeline/archive-pipeline';
import { LlmClient } from './llm/client';
import { IpcServer } from './ipc/server';
import { getIpcSocketPath } from './ipc/paths';
import { handlers, type HandlerContext } from './ipc/handlers';
import { logger } from '../core/logger';

export interface DaemonOptions {
  registry: ProjectRegistry;
  store: MetadataStore;
  /** LLM API Key */
  apiKey?: string;
  /** 自定义 LLM API Base URL */
  apiUrl?: string;
  /** LLM 服务提供商 */
  provider?: 'anthropic' | 'openai';
  /** LLM 模型名称 */
  model?: string;
  /** 自定义 LLM 请求头（JSON 对象） */
  headers?: Record<string, string>;
  /** 全量扫描的 cron 表达式，默认每 5 分钟 */
  scanCron?: string;
  /** 每次扫描最多处理事件数 */
  maxEventsPerScan?: number;
}

export class Daemon {
  private watchers = new Map<string, FileWatcher>();
  private scanJob: ReturnType<typeof schedule> | null = null;
  private running = false;
  private ipcServer: IpcServer | null = null;
  private handlerContext: HandlerContext;

  constructor(private options: DaemonOptions) {
    this.handlerContext = {
      store: options.store,
      registry: options.registry,
      getClient: () =>
        this.options.apiKey
          ? new LlmClient({
              apiKey: this.options.apiKey,
              baseURL: this.options.apiUrl,
              provider: this.options.provider,
              model: this.options.model,
              headers: this.options.headers,
            })
          : null,
      getPipeline: () =>
        new ArchivePipeline({
          store: this.options.store,
          client: new LlmClient({
            apiKey: this.options.apiKey ?? '',
            baseURL: this.options.apiUrl,
            provider: this.options.provider,
            model: this.options.model,
            headers: this.options.headers,
          }),
          maxEvents: this.options.maxEventsPerScan ?? 50,
        }),
      updateDaemonConfig: (config) => this.updateConfig(config),
      getDaemonConfig: () => ({
        apiKey: this.options.apiKey ?? '',
        apiUrl: this.options.apiUrl ?? '',
        provider: this.options.provider ?? 'anthropic',
        model: this.options.model ?? '',
        headers: this.options.headers ? JSON.stringify(this.options.headers) : '',
        scanCron: this.options.scanCron ?? '*/5 * * * *',
      }),
      watchProject: (project) => this.watchProject(project),
      unwatchProject: (projectId) => this.unwatchProject(projectId),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const projects = this.options.registry.list();
    for (const project of projects) {
      this.watchProject(project);
    }

    this.ipcServer = new IpcServer({
      socketPath: getIpcSocketPath(),
      handler: (method, params) => this.handleIpc(method, params),
    });
    await this.ipcServer.start();

    const cron = this.options.scanCron ?? '*/5 * * * *';
    this.scanJob = schedule(cron, () => this.scanAll());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.scanJob?.stop();
    this.scanJob = null;
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    this.watchers.clear();
    await this.ipcServer?.stop();
    this.ipcServer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  updateConfig(config: { apiKey?: string; apiUrl?: string; provider?: 'anthropic' | 'openai'; model?: string; headers?: Record<string, string>; scanCron?: string }): void {
    const persisted: { apiKey?: string; apiUrl?: string; provider?: 'anthropic' | 'openai'; model?: string; headers?: Record<string, string>; scanCron?: string } = {};

    if (config.apiKey !== undefined) {
      this.options.apiKey = config.apiKey;
      persisted.apiKey = config.apiKey;
    }
    if (config.apiUrl !== undefined) {
      this.options.apiUrl = config.apiUrl;
      persisted.apiUrl = config.apiUrl;
    }
    if (config.provider !== undefined) {
      this.options.provider = config.provider;
      persisted.provider = config.provider;
    }
    if (config.model !== undefined) {
      this.options.model = config.model;
      persisted.model = config.model;
    }
    if (config.headers !== undefined) {
      this.options.headers = config.headers;
      persisted.headers = config.headers;
    }
    if (config.scanCron !== undefined) {
      this.options.scanCron = config.scanCron;
      this.scanJob?.stop();
      this.scanJob = schedule(config.scanCron, () => this.scanAll());
      persisted.scanCron = config.scanCron;
    }

    if (Object.keys(persisted).length > 0) {
      saveDaemonConfig(persisted);
    }
  }

  private async handleIpc(method: string, params: unknown): Promise<unknown> {
    const handler = handlers[method];
    if (!handler) throw new Error(`未知 method: ${method}`);
    return handler(this.handlerContext, params);
  }

  watchProject(project: Project): void {
    if (this.watchers.has(project.id)) return;
    const config = loadProjectConfig(project.rootPath, project.archiveRoot);
    const watcher = new FileWatcher();
    watcher.start({
      projectRoot: project.rootPath,
      config,
      onEvent: (event: WatchedEvent) => {
        logger.info({ projectId: project.id, type: event.type, filePath: event.filePath }, '文件事件入库');
        this.options.store.insertEvent({ ...event, projectId: project.id });
      },
      onReady: () => {
        logger.info({ projectId: project.id, projectRoot: project.rootPath }, '项目文件监控已就绪');
      },
      onError: (err) => {
        logger.warn({ projectId: project.id, err }, '文件监控错误');
      },
    });
    this.watchers.set(project.id, watcher);
  }

  unwatchProject(projectId: string): void {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;
    watcher.stop();
    this.watchers.delete(projectId);
  }

  private async scanAll(): Promise<void> {
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      console.warn('[Daemon] 未配置 LLM API Key，跳过归档扫描');
      return;
    }

    const client = new LlmClient({
      apiKey,
      baseURL: this.options.apiUrl,
      provider: this.options.provider,
      model: this.options.model,
      headers: this.options.headers,
    });
    const pipeline = new ArchivePipeline({
      store: this.options.store,
      client,
      maxEvents: this.options.maxEventsPerScan ?? 50,
    });

    const projects = this.options.registry.list();
    for (const project of projects) {
      this.options.store.updateLastScannedAt(project.id, Date.now());
      try {
        await pipeline.run(project);
      } catch (err) {
        console.warn(`[Daemon] 项目扫描失败: ${project.rootPath}`, err);
      }
    }
  }
}
