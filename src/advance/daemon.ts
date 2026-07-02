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
import { LocalModelServiceManager } from './classic/memory/local-model-service.js';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_RERANK_MODEL, getEmbeddingModelDimension, fetchEmbeddingModelDimension } from './classic/memory/local-model-catalog.js';
import { RemoteModelChecker, cleanBaseUrl } from './classic/memory/remote-model-checker.js';
import type { EverosStatus } from '../electron/shared/service-status.js';
import type { RemoteModelStatus } from '../electron/shared/service-status.js';
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
  /** 本地 Embedding 模型名；默认使用 DEFAULT_EMBEDDING_MODEL */
  embeddingModel?: string;
  /** 本地 Rerank 模型名；默认使用 DEFAULT_RERANK_MODEL */
  rerankModel?: string;
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
  private everosStarting = false;
  private everosState: EverosStatus['state'] = 'idle';
  private everosHttpUrl: string | null = null;
  private everosError: string | null = null;
  private localModelManager: LocalModelServiceManager;
  private embeddingDim: number | null = null;
  private remoteModelChecker = new RemoteModelChecker();
  private remoteModelStatus: RemoteModelStatus = {
    llm: { state: 'unconfigured', modelLabel: '未配置', fullModel: '', baseUrl: null, error: null, lastCheckedAt: 0 },
    multimodal: { state: 'unconfigured', modelLabel: '未配置', fullModel: '', baseUrl: null, error: null, lastCheckedAt: 0 },
  };
  private remoteModelCheckTimer: NodeJS.Timeout | null = null;

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

    this.localModelManager = new LocalModelServiceManager({
      embeddingModel: this.options.embeddingModel,
      rerankModel: this.options.rerankModel,
    });

    this.handlerContext = {
      store: options.store,
      registry: options.registry,
      serviceRegistry: this.serviceRegistry,
      dbPath: options.dbPath,
      scanService: this.scanService,
      localModelManager: this.localModelManager,
      remoteModelChecker: this.remoteModelChecker,
      getRemoteModelStatus: () => this.remoteModelStatus,
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
        embeddingModel: this.options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
        rerankModel: this.options.rerankModel ?? DEFAULT_RERANK_MODEL,
        everos: this.options.everos ? JSON.stringify(this.options.everos) : '',
      }),
      isDaemonRunning: () => this.running,
      getEverosStatus: () => this.getEverosStatus(),
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

    // 启动本地 Embedding/Rerank 模型服务（后台进行，不阻塞 IPC），就绪后自动启动 EverOS
    this.localModelManager
      .start()
      .then(async () => {
        if (!this.running) return;
        const status = this.localModelManager.getStatus();
        const ready = status.embedding.state === 'running' && status.rerank.state === 'running';
        if (ready) {
          // 根据实际选用的 HuggingFace embedding 模型解析输出维度，再启动 EverOS
          const embedModel = this.options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
          this.embeddingDim = await fetchEmbeddingModelDimension(embedModel).catch(() => null);
          if (this.embeddingDim) {
            logger.info({ model: embedModel, dim: this.embeddingDim }, '已解析 embedding 模型维度');
          } else {
            logger.warn({ model: embedModel }, '无法从 HuggingFace 解析 embedding 维度，使用本地默认值');
          }
          logger.info('本地模型服务已就绪，尝试启动/重启 EverOS');
          await this.startEverOS();
        } else {
          logger.warn(
            { status },
            '本地模型服务未完全就绪，EverOS 将不会自动启动，Agent 子进程会等待就绪'
          );
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, `本地模型服务未启动: ${message}`);
        logger.warn('本地模型服务未就绪，EverOS 将不会自动启动，Agent 子进程会等待就绪');
      });

    // 初始检测一次远端模型连通性，并启动 30s 轮询
    this.checkRemoteModels().catch((err) => logger.warn({ err }, '初始远端模型检测失败'));
    this.startRemoteModelChecks();

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
    this.localModelManager.stop();
    if (this.remoteModelCheckTimer) {
      clearInterval(this.remoteModelCheckTimer);
      this.remoteModelCheckTimer = null;
    }
    await this.everosMcpServer?.stop();
    this.everosService?.stop();
    this.everosMcpServer = null;
    this.everosService = null;
    this.everosMcpUrl = null;
    this.everosHttpUrl = null;
    this.everosState = 'idle';
    this.everosError = null;
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

  getEverosStatus(): EverosStatus {
    return {
      state: this.everosState,
      url: this.everosHttpUrl,
      error: this.everosError,
    };
  }

  private async checkRemoteModels(): Promise<void> {
    const [llm, multimodal] = await Promise.all([
      this.remoteModelChecker.checkLlm({
        apiKey: this.options.apiKey,
        apiUrl: this.options.apiUrl,
        provider: this.options.provider,
        model: this.options.model,
        headers: this.options.headers,
      }),
      this.remoteModelChecker.checkMultimodal(this.options.everos ?? {}),
    ]);
    this.remoteModelStatus = { llm, multimodal };
  }

  private startRemoteModelChecks(): void {
    if (this.remoteModelCheckTimer) return;
    this.remoteModelCheckTimer = setInterval(() => {
      if (!this.running) return;
      this.checkRemoteModels().catch((err) => {
        logger.warn({ err }, '远端模型状态检测失败');
      });
    }, 30000);
  }

  /**
   * 启动 EverOS + MCP Server。
   *
   * 可被 start() 和 updateConfig() 调用；已启动或正在启动时不会重复执行。
   */
  private async startEverOS(): Promise<void> {
    if (this.everosStarting) return;
    this.everosStarting = true;
    this.everosState = 'starting';
    this.everosError = null;

    // EverOS 必须依赖远端 LLM 配置才能启动，且要求 OpenAI 兼容协议
    const effectiveLlmUrl = (this.options.apiUrl ? cleanBaseUrl(this.options.apiUrl) : undefined) || this.getDefaultLlmBaseUrl(this.options.provider);
    if (!this.options.apiKey || !effectiveLlmUrl) {
      const providerHint = this.options.provider === 'anthropic'
        ? '当前 Provider 为 Anthropic，EverOS LLM 需要 OpenAI 兼容的 Base URL，请在设置页填写代理地址或切换到 OpenAI 兼容 Provider。'
        : '请先在设置页填写 API Key 和 Base URL。';
      const message = `EverOS 需要远端 LLM 配置：${providerHint}`;
      logger.warn(message);
      this.everosState = 'error';
      this.everosError = message;
      this.everosStarting = false;
      return;
    }

    try {
      if (this.everosService && this.everosMcpUrl) {
        this.everosState = 'running';
        return;
      }

      // 清理之前失败或未完成的实例
      if (this.everosService) {
        this.everosService.stop();
        this.everosService = null;
      }
      await this.everosMcpServer?.stop();
      this.everosMcpServer = null;
      this.everosMcpUrl = null;
      this.everosHttpUrl = null;

      const submodulePath = join(__dirname, '..', '..', 'vendor', 'everos');
      this.everosService = new EverOSService({
        submodulePath,
        env: this.buildEverOSEnv(),
      });
      const everosUrl = await this.everosService.start();
      this.handlerContext.everosUrl = everosUrl;
      this.everosHttpUrl = everosUrl;
      this.everosMcpServer = new EverOSMcpServer({ everosUrl });
      this.everosMcpUrl = await this.everosMcpServer.start();
      this.serviceRegistry.setMemoryMcpUrl(this.everosMcpUrl);
      this.everosState = 'running';
      this.everosError = null;
      logger.info({ everosUrl, mcpUrl: this.everosMcpUrl }, 'EverOS 记忆基础设施已启动');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, `EverOS 未启动: ${message}`);
      this.everosState = 'error';
      this.everosError = message;
      // 记忆基础设施失败不应阻塞 daemon 其余功能
      this.everosService = null;
      this.everosMcpServer = null;
      this.everosMcpUrl = null;
      this.everosHttpUrl = null;
    } finally {
      this.everosStarting = false;
    }
  }

  updateConfig(config: {
    apiKey?: string;
    apiUrl?: string;
    provider?: 'anthropic' | 'openai';
    model?: string;
    headers?: Record<string, string>;
    scanCron?: string;
    llmRequestsPerMinute?: number;
    embeddingModel?: string;
    rerankModel?: string;
    everos?: import('./config/daemon-config.js').EverOSConfig;
  }): void {
    const persisted: import('./config/daemon-config.js').DaemonPersistedConfig = {};

    const isChanged = <T>(oldValue: T, newValue: T | undefined): boolean =>
      newValue !== undefined && newValue !== oldValue;

    const memoryConfigChanged =
      isChanged(this.options.apiKey, config.apiKey) ||
      isChanged(this.options.apiUrl, config.apiUrl) ||
      isChanged(this.options.provider, config.provider) ||
      isChanged(this.options.model, config.model) ||
      isChanged(this.options.embeddingModel, config.embeddingModel) ||
      isChanged(this.options.rerankModel, config.rerankModel) ||
      (config.everos !== undefined &&
        JSON.stringify(this.options.everos) !== JSON.stringify(config.everos));

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

    const embeddingModelChanged = isChanged(this.options.embeddingModel, config.embeddingModel);
    const rerankModelChanged = isChanged(this.options.rerankModel, config.rerankModel);
    if (config.embeddingModel !== undefined) {
      this.options.embeddingModel = config.embeddingModel;
      persisted.embeddingModel = config.embeddingModel;
    }
    if (config.rerankModel !== undefined) {
      this.options.rerankModel = config.rerankModel;
      persisted.rerankModel = config.rerankModel;
    }
    if (config.everos !== undefined) {
      this.options.everos = config.everos;
      persisted.everos = config.everos;
    }

    // 本地模型名变更时替换 manager 实例，使新模型在下次启动时生效
    if (embeddingModelChanged || rerankModelChanged) {
      this.localModelManager.stop();
      this.localModelManager = new LocalModelServiceManager({
        embeddingModel: this.options.embeddingModel,
        rerankModel: this.options.rerankModel,
      });
      this.handlerContext.localModelManager = this.localModelManager;
    }

    if (Object.keys(persisted).length > 0) {
      saveDaemonConfig(persisted);
    }

    // 记忆相关配置真正发生变化时：先停掉 EverOS，再启动本地模型服务，最后用新 env 重启 EverOS
    if (this.running && memoryConfigChanged) {
      this.stopEverOS().then(() =>
        this.localModelManager
          .start()
          .then(async () => {
            const status = this.localModelManager.getStatus();
            const ready = status.embedding.state === 'running' && status.rerank.state === 'running';
            if (ready) {
              await this.startEverOS();
            } else {
              logger.warn({ status }, '配置更新后本地模型服务未完全就绪，EverOS 保持停止');
            }
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn({ err }, `配置更新后本地模型服务/EverOS 启动失败: ${message}`);
          })
      );
    }

    // 远端模型配置变化后刷新连通性检测
    const remoteConfigChanged =
      config.apiKey !== undefined ||
      config.apiUrl !== undefined ||
      config.provider !== undefined ||
      config.model !== undefined ||
      config.everos !== undefined;
    if (this.running && remoteConfigChanged) {
      this.checkRemoteModels().catch((err) =>
        logger.warn({ err }, '配置更新后远端模型检测失败')
      );
    }
  }

  private async stopEverOS(): Promise<void> {
    if (this.everosStarting) {
      // 正在启动时避免竞态，简单置标记让启动完成后自然结束
      this.everosStarting = false;
    }
    this.everosState = 'idle';
    this.everosError = null;
    this.everosHttpUrl = null;
    this.everosMcpUrl = null;
    this.handlerContext.everosUrl = undefined;
    await this.everosMcpServer?.stop();
    this.everosMcpServer = null;
    this.everosService?.stop();
    this.everosService = null;
  }

  private buildEverOSEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const agent = {
      apiKey: this.options.apiKey,
      apiUrl: this.options.apiUrl,
      model: this.options.model,
    };
    const cfg = this.options.everos ?? {};

    // Embedding / Rerank：使用本地模型服务，未就绪时回退到 Agent 通用配置
    // 本地 infinity_emb 使用 --url-prefix /v1，所以传给 EverOS 的 base_url 需要带 /v1 后缀
    const embedKey = agent.apiKey ?? 'local';
    const rawEmbedUrl = this.localModelManager.getEmbeddingUrl() ?? agent.apiUrl;
    const embedUrl = rawEmbedUrl ? this.ensureLocalModelBaseUrl(rawEmbedUrl) : undefined;
    const embedModel = this.options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    if (embedKey) env.EVEROS_EMBEDDING__API_KEY = embedKey;
    if (embedUrl) env.EVEROS_EMBEDDING__BASE_URL = embedUrl;
    env.EVEROS_EMBEDDING__MODEL = embedModel;
    env.EVEROS_EMBEDDING__DIM = String(this.embeddingDim ?? getEmbeddingModelDimension(embedModel));

    const rerankKey = agent.apiKey ?? 'local';
    const rawRerankUrl = this.localModelManager.getRerankUrl() ?? agent.apiUrl;
    const rerankUrl = rawRerankUrl ? this.ensureLocalModelBaseUrl(rawRerankUrl) : undefined;
    const rerankModel = this.options.rerankModel ?? DEFAULT_RERANK_MODEL;
    if (rerankKey) env.EVEROS_RERANK__API_KEY = rerankKey;
    if (rerankUrl) env.EVEROS_RERANK__BASE_URL = rerankUrl;
    env.EVEROS_RERANK__MODEL = rerankModel;
    // 本地 rerank 使用 infinity_emb 的 OpenAI-compatible /v1/rerank，显式指定 vllm provider
    // 避免 EverOS 按 host 推断成 deepinfra
    if (this.localModelManager.getRerankUrl()) {
      env.EVEROS_RERANK__PROVIDER = 'vllm';
    }

    // LLM：EverOS 的 LLM 客户端使用 OpenAI 兼容协议；优先使用用户填写的 Base URL，
    // OpenAI 官方 provider 留空时补全默认值，Anthropic 原生 API 不兼容，不自动补全
    const effectiveLlmUrl = (agent.apiUrl ? cleanBaseUrl(agent.apiUrl) : undefined) || this.getDefaultLlmBaseUrl(this.options.provider);
    if (agent.apiKey) env.EVEROS_LLM__API_KEY = agent.apiKey;
    if (effectiveLlmUrl) env.EVEROS_LLM__BASE_URL = effectiveLlmUrl;
    if (agent.model) env.EVEROS_LLM__MODEL = agent.model;

    // memorize 流水线可能调用 LLM，若 LLM 无响应会长期占用 per-session lock；
    // 将 lock 超时从默认 360s 降到 120s，避免单个卡住的调用阻塞同一 MR session 的后续记忆写入
    env.EVEROS_MEMORIZE__SESSION_LOCK_TIMEOUT_SECONDS = '120';

    logger.info(
      { provider: this.options.provider, baseUrl: effectiveLlmUrl ?? 'unset', model: agent.model || 'default' },
      '构建 EverOS LLM 环境变量'
    );

    // Multimodal：仅使用显式配置，未配置时不回退到 Agent LLM
    const mmKey = cfg.multimodalApiKey;
    const mmUrl = cfg.multimodalBaseUrl;
    const mmModel = cfg.multimodalModel;
    if (mmKey) env.EVEROS_MULTIMODAL__API_KEY = mmKey;
    if (mmUrl) env.EVEROS_MULTIMODAL__BASE_URL = mmUrl;
    if (mmModel) env.EVEROS_MULTIMODAL__MODEL = mmModel;

    return env;
  }

  private getDefaultLlmBaseUrl(provider?: string): string | undefined {
    // EverOS 的 LLM 模块只支持 OpenAI 兼容协议；Anthropic 原生 /v1/messages 不兼容
    if (provider === 'openai') {
      return 'https://api.openai.com/v1';
    }
    return undefined;
  }

  /**
   * 确保本地模型服务的 base_url 带 /v1 前缀。
   *
   * infinity_emb 启动时带 --url-prefix /v1，OpenAI SDK 会再拼 /embeddings 或 /rerank；
   * 如果直接传裸地址，EverOS 会请求 /embeddings 而不是 /v1/embeddings，导致 404。
   */
  private ensureLocalModelBaseUrl(url: string): string {
    const trimmed = url.replace(/\/+$/, '');
    if (trimmed.endsWith('/v1')) {
      return trimmed;
    }
    return `${trimmed}/v1`;
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
