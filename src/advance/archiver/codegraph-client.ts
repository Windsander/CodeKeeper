import type { Project } from '../types.js';
import {
  ArchiverProviderOrchestrator,
  type ArchiverProviderCoordinator,
  type ArchiverProviderExecution,
} from './provider-orchestrator.js';
import { ArchiverProviderRegistry } from './provider-registry.js';
import { BuiltinProviderAdapter } from './adapters/builtin-provider-adapter.js';
import type {
  ArchiverProviderContextRequest,
  ArchiverProviderExecutionStrategy,
  ArchiverProviderQueryRequest,
  ArchiverProviderRunReport,
} from './provider-types.js';

interface CodeGraphFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type CodeGraphFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<CodeGraphFetchResponse>;

export interface CodeGraphClientOptions {
  baseUrl: string;
  fetch?: CodeGraphFetch;
  timeoutMs?: number;
}

interface CodeGraphRpcResponse {
  ok?: boolean;
  result?: unknown;
  error?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const SERVER_MANAGED_STRATEGY: ArchiverProviderExecutionStrategy = {
  schemaVersion: 1,
  primary: 'builtin',
  fallbacks: [],
  enrichers: [],
  builtinFallback: true,
};

/** 角色子进程使用的 CodeGraph Server 客户端。 */
export class CodeGraphClient implements ArchiverProviderCoordinator {
  private readonly baseUrl: string;
  private readonly fetchImpl: CodeGraphFetch;
  private readonly timeoutMs: number;
  private readonly automaticStrategy: ArchiverProviderExecutionStrategy;

  constructor(options: CodeGraphClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl =
      options.fetch ??
      ((url, init) => fetch(url, init) as unknown as Promise<CodeGraphFetchResponse>);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // 仅兼容现有协调器签名；Provider 遴选始终由服务端 Registry 决定。
    this.automaticStrategy = SERVER_MANAGED_STRATEGY;
  }

  getAutomaticStrategy(): ArchiverProviderExecutionStrategy {
    return this.automaticStrategy;
  }

  hasProjectKnowledgeSource(
    project: Project,
    _archiveRoot: string,
    _strategy: ArchiverProviderExecutionStrategy = this.automaticStrategy
  ): Promise<boolean> {
    return this.call<boolean>('project.knowledge.available', { projectId: project.id });
  }

  loadProjectKnowledgeContext(
    project: Project,
    _archiveRoot: string,
    _strategy: ArchiverProviderExecutionStrategy = this.automaticStrategy,
    request: ArchiverProviderContextRequest = {}
  ): Promise<string> {
    return this.call<string>('project.knowledge.context', {
      projectId: project.id,
      request,
    });
  }

  queryProjectKnowledge(
    project: Project,
    _archiveRoot: string,
    _strategy: ArchiverProviderExecutionStrategy,
    request: ArchiverProviderQueryRequest
  ): Promise<string[]> {
    return this.call<string[]>('project.knowledge.query', {
      projectId: project.id,
      request,
    });
  }

  syncProject(
    project: Project,
    _archiveRoot: string,
    _strategy: ArchiverProviderExecutionStrategy = this.automaticStrategy
  ): Promise<ArchiverProviderExecution> {
    return this.call<ArchiverProviderExecution>('project.sync', { projectId: project.id });
  }

  async finalizeBuiltin(
    project: Project,
    _archiveRoot: string,
    report: ArchiverProviderRunReport,
    success: boolean,
    message: string
  ): Promise<void> {
    await this.call('project.finalize-builtin', {
      projectId: project.id,
      report,
      success,
      message,
    });
  }

  private async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as CodeGraphRpcResponse;
      if (!response.ok || payload.ok !== true) {
        const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(`CodeGraph Server 请求失败：${detail}`);
      }
      return payload.result as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`CodeGraph Server 请求超时：${method}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 优先连接 Daemon 托管的 Server；无服务地址时仅保留内置安全回退。 */
export function createArchiverProviderCoordinator(
  baseUrl = process.env.CK_CODEGRAPH_SERVER_URL?.trim()
): ArchiverProviderCoordinator {
  return baseUrl
    ? new CodeGraphClient({ baseUrl })
    : new ArchiverProviderOrchestrator({
        registry: new ArchiverProviderRegistry([new BuiltinProviderAdapter()]),
        autoPrepare: false,
      });
}
