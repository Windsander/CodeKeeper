import { schedule } from 'node-cron';
import type { ProjectRegistry } from './project-registry';
import { FileWatcher } from './file-watcher';
import type { MetadataStore } from './store/metadata-store';
import type { Project, WatchedEvent } from './types';
import { getArchiveRoot } from './types';
import { loadProjectConfig } from './config/project-config';
import { saveDaemonConfig } from './config/daemon-config';
import { IpcServer } from './ipc/server';
import { getIpcSocketPath } from './ipc/paths';
import { handlers, type HandlerContext } from './ipc/handlers';
import { logger } from '../core/logger';
import { LlmClient } from './llm/client';
import { RoleServiceRegistry } from './classic/role-service-registry.js';
import { ROLES } from './types.js';
import { ScanService } from './scan/scan-service.js';
import { GitLabProvider } from './classic/provider/gitlab-provider.js';
import { EverOSService } from './classic/memory/everos-service.js';
import { EverOSMcpServer } from './classic/memory/everos-mcp-server.js';
import path from 'node:path';
import { join } from 'node:path';

export interface DaemonOptions {
  registry: ProjectRegistry;
  store: MetadataStore;
  /** 数据库文件路径，用于启动扫描 worker */
  dbPath: string;
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
  /** 每分钟 LLM 请求数限制，默认 10 */
  llmRequestsPerMinute?: number;
  /** EverOS 独立配置；未设置时继承 Agent 通用配置 */
  everos?: import('./config/daemon-config.js').EverOSConfig;
}

export class Daemon {
  private watchers = new Map<string, FileWatcher[]>();
  private scanJob: ReturnType<typeof schedule> | null = null;
  private running = false;
  private ipcServer: IpcServer | null = null;
  private watcherInitImmediate: NodeJS.Immediate | null = null;
  private watcherTimeout: NodeJS.Timeout | null = null;
  private handlerContext: HandlerContext;
  private serviceRegistry: RoleServiceRegistry;
  private scanService: ScanService;
  private everosService: EverOSService | null = null;
  private everosMcpServer: EverOSMcpServer | null = null;
  private everosMcpUrl: string | null = null;

  constructor(private options: DaemonOptions) {
    // 初始化角色服务注册表，注册所有支持的角色
    this.serviceRegistry = new RoleServiceRegistry(
      // 先创建占位 context，等 scanService 初始化后再补全
      {} as HandlerContext,
      path.join(__dirname, 'classic', 'agent-entries', 'role-entry.js')
    );
    for (const role of ROLES) {
      this.serviceRegistry.register(role);
    }

    this.scanService = new ScanService({
      store: options.store,
      registry: options.registry,
      dbPath: options.dbPath,
      getDaemonConfig: () => ({
        apiKey: this.options.apiKey ?? '',
        apiUrl: this.options.apiUrl ?? '',
        provider: this.options.provider ?? 'anthropic',
        model: this.options.model ?? '',
        headers: this.options.headers ?? {},
        llmRequestsPerMinute: this.options.llmRequestsPerMinute ?? 10,
      }),
      maxEventsPerScan: this.options.maxEventsPerScan,
    });

    this.handlerContext = {
      store: options.store,
      registry: options.registry,
      serviceRegistry: this.serviceRegistry,
      dbPath: options.dbPath,
      scanService: this.scanService,
      getProvider: (project) => {
        if (project.gitlab) {
          return new GitLabProvider(project.gitlab);
        }
        return null;
      },
      getClient: () =>
        this.options.apiKey
          ? new LlmClient({
              apiKey: this.options.apiKey,
              baseURL: this.options.apiUrl,
              provider: this.options.provider,
              model: this.options.model,
              headers: this.options.headers,
              minRequestInterval: this.llmRequestInterval(),
            })
          : null,
      updateDaemonConfig: (config) => this.updateConfig(config),
      getDaemonConfig: () => ({
        apiKey: this.options.apiKey ?? '',
        apiUrl: this.options.apiUrl ?? '',
        provider: this.options.provider ?? 'anthropic',
        model: this.options.model ?? '',
        headers: this.options.headers ? JSON.stringify(this.options.headers) : '',
        scanCron: this.options.scanCron ?? '*/5 * * * *',
        llmRequestsPerMinute: this.options.llmRequestsPerMinute ?? 10,
        everos: this.options.everos ? JSON.stringify(this.options.everos) : '',
      }),
      watchProject: (project) => this.watchProject(project),
      unwatchProject: (projectId) => this.unwatchProject(projectId),
    };

    // 将完整的 handlerContext 回设到 serviceRegistry
    this.serviceRegistry.context = this.handlerContext;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.ipcServer = new IpcServer({
      socketPath: getIpcSocketPath(),
      handler: (method, params) => this.handleIpc(method, params),
    });
    await this.ipcServer.start();

    // 启动 EverOS 本地记忆基础设施，所有角色服务共享同一套实例
    try {
      const submodulePath = join(__dirname, '..', '..', 'vendor', 'everos');
      this.everosService = new EverOSService({
        submodulePath,
        env: this.buildEverOSEnv(),
      });
      const everosUrl = await this.everosService.start();
      this.handlerContext.everosUrl = everosUrl;
      this.everosMcpServer = new EverOSMcpServer({ everosUrl });
      this.everosMcpUrl = await this.everosMcpServer.start();
      this.serviceRegistry.setMemoryMcpUrl(this.everosMcpUrl);
      logger.info({ everosUrl, mcpUrl: this.everosMcpUrl }, 'EverOS 记忆基础设施已启动');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, `EverOS 启动失败: ${message}`);
      // 记忆基础设施失败不应阻塞 daemon 其余功能
    }

    // IPC server 启动后，把文件监控等非关键初始化推迟到下一个事件循环，
    // 让 UI 在 App 刚打开时能立即响应 IPC 请求，避免按钮点击延迟。
    // MR Agent 调度服务（ClassicService）不随 daemon 启动，由 UI 的“启动服务”按钮控制。
    this.watcherInitImmediate = setImmediate(() => {
      // 进一步延迟 watcher 启动 3 秒，避免 App 启动瞬间的 IO 峰值阻塞主进程事件循环
      this.watcherTimeout = setTimeout(() => {
        const projects = this.options.registry.list();
        // 错开每个项目 watcher 的启动时间，避免多个 chokidar 同时扫描目录阻塞事件循环
        projects.forEach((project, index) => {
          setTimeout(() => this.watchProject(project), index * 500);
        });
      }, 3000);
    });

    const cron = this.options.scanCron ?? '*/5 * * * *';
    this.scanJob = schedule(cron, () => this.scanService.scanAllProjects());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.watcherInitImmediate) {
      clearImmediate(this.watcherInitImmediate);
      this.watcherInitImmediate = null;
    }
    if (this.watcherTimeout) {
      clearTimeout(this.watcherTimeout);
      this.watcherTimeout = null;
    }
    // 停止所有角色服务
    for (const role of ROLES) {
      await this.serviceRegistry.stop(role);
    }
    this.scanService.stop();
    this.scanJob?.stop();
    this.scanJob = null;
    await this.everosMcpServer?.stop();
    this.everosService?.stop();
    this.everosMcpServer = null;
    this.everosService = null;
    this.everosMcpUrl = null;
    for (const watchers of this.watchers.values()) {
      for (const watcher of watchers) {
        watcher.stop();
      }
    }
    this.watchers.clear();
    await this.ipcServer?.stop();
    this.ipcServer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  updateConfig(config: { apiKey?: string; apiUrl?: string; provider?: 'anthropic' | 'openai'; model?: string; headers?: Record<string, string>; scanCron?: string; llmRequestsPerMinute?: number; everos?: import('./config/daemon-config.js').EverOSConfig }): void {
    const persisted: import('./config/daemon-config.js').DaemonPersistedConfig = {};

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
      this.scanJob = schedule(config.scanCron, () => this.scanService.scanAllProjects());
      persisted.scanCron = config.scanCron;
    }
    if (config.llmRequestsPerMinute !== undefined) {
      this.options.llmRequestsPerMinute = config.llmRequestsPerMinute;
      persisted.llmRequestsPerMinute = config.llmRequestsPerMinute;
    }
    if (config.everos !== undefined) {
      this.options.everos = config.everos;
      persisted.everos = config.everos;
    }

    if (Object.keys(persisted).length > 0) {
      saveDaemonConfig(persisted);
    }
  }

  private buildEverOSEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const agent = {
      apiKey: this.options.apiKey,
      apiUrl: this.options.apiUrl,
      model: this.options.model,
    };
    const cfg = this.options.everos ?? {};

    const llmKey = cfg.llmApiKey ?? agent.apiKey;
    const llmUrl = cfg.llmBaseUrl ?? agent.apiUrl;
    const llmModel = cfg.llmModel ?? agent.model;
    if (llmKey) env.EVEROS_LLM__API_KEY = llmKey;
    if (llmUrl) env.EVEROS_LLM__BASE_URL = llmUrl;
    if (llmModel) env.EVEROS_LLM__MODEL = llmModel;

    const embedKey = cfg.embeddingApiKey ?? agent.apiKey;
    const embedUrl = cfg.embeddingBaseUrl ?? agent.apiUrl;
    const embedModel = cfg.embeddingModel;
    if (embedKey) env.EVEROS_EMBEDDING__API_KEY = embedKey;
    if (embedUrl) env.EVEROS_EMBEDDING__BASE_URL = embedUrl;
    if (embedModel) env.EVEROS_EMBEDDING__MODEL = embedModel;

    const mmKey = cfg.multimodalApiKey ?? agent.apiKey;
    const mmUrl = cfg.multimodalBaseUrl ?? agent.apiUrl;
    const mmModel = cfg.multimodalModel;
    if (mmKey) env.EVEROS_MULTIMODAL__API_KEY = mmKey;
    if (mmUrl) env.EVEROS_MULTIMODAL__BASE_URL = mmUrl;
    if (mmModel) env.EVEROS_MULTIMODAL__MODEL = mmModel;

    const rerankKey = cfg.rerankApiKey ?? agent.apiKey;
    const rerankUrl = cfg.rerankBaseUrl ?? agent.apiUrl;
    const rerankModel = cfg.rerankModel;
    if (rerankKey) env.EVEROS_RERANK__API_KEY = rerankKey;
    if (rerankUrl) env.EVEROS_RERANK__BASE_URL = rerankUrl;
    if (rerankModel) env.EVEROS_RERANK__MODEL = rerankModel;

    return env;
  }

  private llmRequestInterval(): number {
    const rpm = this.options.llmRequestsPerMinute ?? 10;
    if (rpm <= 0) return 6000;
    return Math.ceil(60000 / rpm);
  }

  private async handleIpc(method: string, params: unknown): Promise<unknown> {
    const handler = handlers[method];
    if (!handler) throw new Error(`未知 method: ${method}`);
    return handler(this.handlerContext, params);
  }

  watchProject(project: Project): void {
    if (this.watchers.has(project.id)) return;

    const config = loadProjectConfig(project.rootPath, project.archiveRoot);
    const watchers: FileWatcher[] = [];

    // 监听原项目文件
    const sourceWatcher = new FileWatcher();
    sourceWatcher.start({
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
    watchers.push(sourceWatcher);

    // 监听归档目录，实时通知 UI 刷新文件树
    const archiveRoot = getArchiveRoot(project);
    if (archiveRoot !== project.rootPath) {
      const archiveWatcher = new FileWatcher();
      archiveWatcher.start({
        projectRoot: archiveRoot,
        config: { include: [], exclude: [], categories: config.categories, docTypes: config.docTypes },
        onEvent: (event: WatchedEvent) => {
          this.ipcServer?.broadcast('archive-tree-changed', {
            projectId: project.id,
            type: event.type,
            filePath: event.filePath,
          });
        },
        onError: (err) => {
          logger.warn({ projectId: project.id, archiveRoot, err }, '归档目录监控错误');
        },
      });
      watchers.push(archiveWatcher);
    }

    this.watchers.set(project.id, watchers);
  }

  unwatchProject(projectId: string): void {
    const watchers = this.watchers.get(projectId);
    if (!watchers) return;
    for (const watcher of watchers) {
      watcher.stop();
    }
    this.watchers.delete(projectId);
  }
}
