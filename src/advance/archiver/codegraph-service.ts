import http, {
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import { logger } from '../../core/logger.js';
import type {
  CodeGraphProviderStatus,
  CodeGraphServiceStatus,
} from '../../electron/shared/service-status.js';
import type { Project } from '../types.js';
import { getArchiveRoot } from '../types.js';
import {
  ArchiverProviderOrchestrator,
  type ArchiverProviderCoordinator,
  type ArchiverProviderExecution,
} from './provider-orchestrator.js';
import type {
  ArchiverProviderContextRequest,
  ArchiverProviderDescriptor,
  ArchiverProviderExecutionStrategy,
  ArchiverProviderProbeResult,
  ArchiverProviderQueryRequest,
  ArchiverProviderRunReport,
} from './provider-types.js';

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export type CodeGraphServiceBackend = Pick<
  ArchiverProviderOrchestrator,
  | 'listProviders'
  | 'getAutomaticStrategy'
  | 'prepareProvider'
  | 'probeProject'
  | 'readStatus'
  | 'hasProjectKnowledgeSource'
  | 'loadProjectKnowledgeContext'
  | 'queryProjectKnowledge'
  | 'syncProject'
  | 'finalizeBuiltin'
>;

export interface CodeGraphServiceOptions {
  registry: { get(projectId: string): Project | null };
  orchestrator?: CodeGraphServiceBackend;
  port?: number;
  autoPrepare?: boolean;
}

export interface CodeGraphServiceController extends ArchiverProviderCoordinator {
  start(): Promise<string>;
  stop(): Promise<void>;
  getStatus(): CodeGraphServiceStatus;
  listProviders(): ArchiverProviderDescriptor[];
  probeProject(
    project: Project,
    archiveRoot: string,
    strategy?: ArchiverProviderExecutionStrategy
  ): Promise<ArchiverProviderProbeResult[]>;
  readStatus(archiveRoot: string): Promise<ArchiverProviderRunReport | null>;
}

interface RpcRequest {
  method?: unknown;
  params?: unknown;
}

/** Daemon 托管的单一 CodeGraph 服务，统一管理 Provider 运行时和项目任务。 */
export class CodeGraphService implements CodeGraphServiceController {
  private readonly registry: CodeGraphServiceOptions['registry'];
  private readonly orchestrator: CodeGraphServiceBackend;
  private readonly port: number;
  private readonly autoPrepare: boolean;
  private readonly providerStatuses = new Map<string, CodeGraphProviderStatus>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private readonly syncJobs = new Map<string, Promise<ArchiverProviderExecution>>();
  private httpServer: HttpServer | null = null;
  private state: CodeGraphServiceStatus['state'] = 'idle';
  private url: string | null = null;
  private error: string | null = null;
  private activeJobs = 0;
  private queuedJobs = 0;
  private stopping = false;

  constructor(options: CodeGraphServiceOptions) {
    this.registry = options.registry;
    this.orchestrator = options.orchestrator ?? new ArchiverProviderOrchestrator();
    this.port = options.port ?? 0;
    this.autoPrepare = options.autoPrepare ?? true;
    this.resetProviderStatuses();
  }

  async start(): Promise<string> {
    if (this.httpServer && this.url) return this.url;

    this.stopping = false;
    this.state = 'starting';
    this.error = null;
    this.resetProviderStatuses();

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch(error => {
        logger.warn({ err: error }, 'CodeGraph Server 请求处理失败');
        if (!response.headersSent) {
          this.writeJson(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'CodeGraph 请求处理失败',
          });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    this.httpServer = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const handleError = (error: Error) => reject(error);
        server.once('error', handleError);
        server.listen(this.port, '127.0.0.1', () => {
          server.off('error', handleError);
          resolve();
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : this.port;
      this.url = `http://127.0.0.1:${port}`;
      this.state = 'running';
      server.on('error', error => {
        logger.error({ err: error }, 'CodeGraph Server 运行异常');
        this.state = 'error';
        this.error = 'CodeGraph Server 运行异常，请查看 Daemon 日志';
      });
      server.on('close', () => {
        if (!this.stopping && this.httpServer === server) {
          this.state = 'error';
          this.error = 'CodeGraph Server 已意外停止';
          this.url = null;
        }
      });
      if (this.autoPrepare) void this.prepareProviders();
      logger.info({ url: this.url }, 'CodeGraph Server 已启动');
      return this.url;
    } catch (error) {
      this.httpServer = null;
      this.url = null;
      this.state = 'error';
      this.error = 'CodeGraph Server 启动失败，请查看 Daemon 日志';
      logger.error({ err: error }, 'CodeGraph Server 启动失败');
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.stopping = true;
    this.httpServer = null;
    if (server) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    }
    this.url = null;
    this.error = null;
    this.state = 'idle';
    this.stopping = false;
  }

  getStatus(): CodeGraphServiceStatus {
    return {
      state: this.state,
      url: this.url,
      error: this.error,
      activeJobs: this.activeJobs,
      queuedJobs: this.queuedJobs,
      providers: this.listProviders().map(descriptor => ({
        ...(this.providerStatuses.get(descriptor.id) ?? this.initialProviderStatus(descriptor)),
      })),
    };
  }

  listProviders(): ArchiverProviderDescriptor[] {
    return this.orchestrator.listProviders();
  }

  getAutomaticStrategy(): ArchiverProviderExecutionStrategy {
    return this.orchestrator.getAutomaticStrategy();
  }

  probeProject(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy()
  ): Promise<ArchiverProviderProbeResult[]> {
    return this.runProjectRead(project.id, () =>
      this.orchestrator.probeProject(project, archiveRoot, strategy)
    );
  }

  readStatus(archiveRoot: string): Promise<ArchiverProviderRunReport | null> {
    return this.orchestrator.readStatus(archiveRoot);
  }

  hasProjectKnowledgeSource(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy()
  ): Promise<boolean> {
    return this.runProjectRead(project.id, () =>
      this.orchestrator.hasProjectKnowledgeSource(project, archiveRoot, strategy)
    );
  }

  loadProjectKnowledgeContext(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy(),
    request: ArchiverProviderContextRequest = {}
  ): Promise<string> {
    return this.runProjectRead(project.id, () =>
      this.orchestrator.loadProjectKnowledgeContext(project, archiveRoot, strategy, request)
    );
  }

  queryProjectKnowledge(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy,
    request: ArchiverProviderQueryRequest
  ): Promise<string[]> {
    return this.runProjectRead(project.id, () =>
      this.orchestrator.queryProjectKnowledge(project, archiveRoot, strategy, request)
    );
  }

  syncProject(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy()
  ): Promise<ArchiverProviderExecution> {
    const existing = this.syncJobs.get(project.id);
    if (existing) return existing;

    const job = this.enqueueProjectMutation(project.id, () =>
      this.orchestrator.syncProject(project, archiveRoot, strategy)
    );
    this.syncJobs.set(project.id, job);
    void job.then(
      () => this.clearSyncJob(project.id, job),
      () => this.clearSyncJob(project.id, job)
    );
    return job;
  }

  finalizeBuiltin(
    project: Project,
    archiveRoot: string,
    report: ArchiverProviderRunReport,
    success: boolean,
    message: string
  ): Promise<void> {
    return this.enqueueProjectMutation(project.id, () =>
      this.orchestrator.finalizeBuiltin(project, archiveRoot, report, success, message)
    );
  }

  private clearSyncJob(
    projectId: string,
    job: Promise<ArchiverProviderExecution>
  ): void {
    if (this.syncJobs.get(projectId) === job) this.syncJobs.delete(projectId);
  }

  private resetProviderStatuses(): void {
    this.providerStatuses.clear();
    for (const descriptor of this.orchestrator.listProviders()) {
      this.providerStatuses.set(descriptor.id, this.initialProviderStatus(descriptor));
    }
  }

  private initialProviderStatus(
    descriptor: ArchiverProviderDescriptor
  ): CodeGraphProviderStatus {
    if (descriptor.kind === 'builtin') {
      return {
        providerId: descriptor.id,
        displayName: descriptor.displayName,
        state: 'ready',
        prepared: true,
        version: null,
        message: '应用内置能力',
      };
    }
    if (descriptor.managedRuntime) {
      return {
        providerId: descriptor.id,
        displayName: descriptor.displayName,
        state: 'preparable',
        prepared: false,
        version: descriptor.managedRuntime.version,
        message: '等待系统自动准备',
      };
    }
    return {
      providerId: descriptor.id,
      displayName: descriptor.displayName,
      state: descriptor.automation === 'manual' ? 'manual' : 'unavailable',
      prepared: false,
      version: null,
      message:
        descriptor.automation === 'manual'
          ? '需要 Agent 工作流调度'
          : '未声明可用运行时',
    };
  }

  private async prepareProviders(): Promise<void> {
    for (const descriptor of this.listProviders()) {
      if (this.stopping || descriptor.kind === 'builtin' || !descriptor.managedRuntime) continue;
      this.providerStatuses.set(descriptor.id, {
        providerId: descriptor.id,
        displayName: descriptor.displayName,
        state: 'preparing',
        prepared: false,
        version: descriptor.managedRuntime.version,
        message: '正在准备应用私有运行时',
      });
      try {
        const result = await this.orchestrator.prepareProvider(descriptor.id);
        if (this.stopping) return;
        this.providerStatuses.set(descriptor.id, {
          providerId: descriptor.id,
          displayName: descriptor.displayName,
          state: result.success
            ? result.manual || descriptor.automation === 'manual'
              ? 'manual'
              : 'ready'
            : 'unavailable',
          prepared: result.prepared,
          version: result.version ?? descriptor.managedRuntime.version,
          message: result.success
            ? result.manual || descriptor.automation === 'manual'
              ? 'Skill 已准备，等待 Agent 工作流调度'
              : '托管运行时已就绪'
            : '自动准备失败，请查看 Daemon 日志',
        });
        if (!result.success) {
          logger.warn(
            { providerId: descriptor.id, detail: result.message },
            'CodeGraph Provider 自动准备失败'
          );
        }
      } catch (error) {
        if (this.stopping) return;
        this.providerStatuses.set(descriptor.id, {
          providerId: descriptor.id,
          displayName: descriptor.displayName,
          state: 'unavailable',
          prepared: false,
          version: descriptor.managedRuntime.version,
          message: '自动准备失败，请查看 Daemon 日志',
        });
        logger.warn({ err: error, providerId: descriptor.id }, 'CodeGraph Provider 自动准备异常');
      }
    }
  }

  private enqueueProjectMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectTails.get(projectId);
    if (previous) this.queuedJobs += 1;
    const result = (async () => {
      if (previous) {
        try {
          await previous;
        } finally {
          this.queuedJobs = Math.max(0, this.queuedJobs - 1);
        }
      }
      this.activeJobs += 1;
      try {
        return await operation();
      } finally {
        this.activeJobs = Math.max(0, this.activeJobs - 1);
      }
    })();
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.projectTails.set(projectId, tail);
    void tail.then(() => {
      if (this.projectTails.get(projectId) === tail) this.projectTails.delete(projectId);
    });
    return result;
  }

  private async runProjectRead<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.projectTails.get(projectId);
    if (pending) {
      this.queuedJobs += 1;
      try {
        await pending;
      } finally {
        this.queuedJobs = Math.max(0, this.queuedJobs - 1);
      }
    }
    this.activeJobs += 1;
    try {
      return await operation();
    } finally {
      this.activeJobs = Math.max(0, this.activeJobs - 1);
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      this.writeJson(response, 200, { ok: true, result: this.getStatus() });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/rpc') {
      this.writeJson(response, 404, { ok: false, error: 'not found' });
      return;
    }

    const body = (await this.readJsonBody(request)) as RpcRequest;
    if (typeof body.method !== 'string') throw new Error('缺少 CodeGraph RPC method');
    const result = await this.dispatch(body.method, body.params);
    this.writeJson(response, 200, { ok: true, result });
  }

  private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const params = asRecord(rawParams);
    const project = this.getProject(params.projectId);
    const archiveRoot = getArchiveRoot(project);
    switch (method) {
      case 'project.sync':
        return this.syncProject(project, archiveRoot);
      case 'project.finalize-builtin': {
        const report = params.report;
        if (!isRunReport(report) || report.projectId !== project.id) {
          throw new Error('CodeGraph 编排报告无效');
        }
        await this.finalizeBuiltin(
          project,
          archiveRoot,
          report,
          params.success === true,
          typeof params.message === 'string' ? params.message : ''
        );
        return null;
      }
      case 'project.knowledge.available':
        return this.hasProjectKnowledgeSource(project, archiveRoot);
      case 'project.knowledge.context':
        return this.loadProjectKnowledgeContext(
          project,
          archiveRoot,
          this.getAutomaticStrategy(),
          parseContextRequest(params.request)
        );
      case 'project.knowledge.query':
        return this.queryProjectKnowledge(
          project,
          archiveRoot,
          this.getAutomaticStrategy(),
          parseQueryRequest(params.request)
        );
      default:
        throw new Error(`未知 CodeGraph RPC method: ${method}`);
    }
  }

  private getProject(value: unknown): Project {
    if (typeof value !== 'string' || !value.trim()) throw new Error('缺少项目 ID');
    const project = this.registry.get(value);
    if (!project) throw new Error(`项目不存在: ${value}`);
    return project;
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BODY_BYTES) throw new Error('CodeGraph 请求体过大');
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseContextRequest(value: unknown): ArchiverProviderContextRequest {
  const request = asRecord(value);
  return {
    ...(typeof request.maxChars === 'number' ? { maxChars: request.maxChars } : {}),
  };
}

function parseQueryRequest(value: unknown): ArchiverProviderQueryRequest {
  const request = asRecord(value);
  if (typeof request.query !== 'string' || !request.query.trim()) {
    throw new Error('CodeGraph 查询内容不能为空');
  }
  return {
    query: request.query,
    ...(request.role === 'reviewer' || request.role === 'maintainer' || request.role === 'archiver'
      ? { role: request.role }
      : {}),
    ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
    ...(typeof request.maxChars === 'number' ? { maxChars: request.maxChars } : {}),
  };
}

function isRunReport(value: unknown): value is ArchiverProviderRunReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<ArchiverProviderRunReport>;
  return (
    report.schemaVersion === 1 &&
    typeof report.projectId === 'string' &&
    typeof report.selectedPrimary === 'string' &&
    Number.isFinite(report.generatedAt) &&
    Array.isArray(report.statuses)
  );
}
