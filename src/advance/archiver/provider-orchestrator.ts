import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../core/logger.js';
import type { Project } from '../types.js';
import { BUILTIN_ARCHIVER_PROVIDER_ID } from './provider-config.js';
import {
  createDefaultArchiverProviderRegistry,
  ArchiverProviderRegistry,
} from './provider-registry.js';
import { ProviderShell, type ProviderCommandRunner } from './provider-shell.js';
import { ManagedProviderRuntime } from './managed-provider-runtime.js';
import type {
  ArchiverProviderAdapter,
  ArchiverProviderContextRequest,
  ArchiverProviderDescriptor,
  ArchiverProviderExecutionStrategy,
  ArchiverProviderOverride,
  ArchiverProviderPlacement,
  ArchiverProviderPrepareResult,
  ArchiverProviderProvisioner,
  ArchiverProviderProbeResult,
  ArchiverProviderQueryRequest,
  ArchiverProviderRunReport,
  ArchiverProviderRunStatus,
  ArchiverProviderSyncContext,
} from './provider-types.js';
import { capKnowledgeItems } from './provider-query-utils.js';

export interface ArchiverProviderOrchestratorOptions {
  registry?: ArchiverProviderRegistry;
  shell?: ProviderCommandRunner;
  provisioner?: ArchiverProviderProvisioner;
  providerRuntimeRoot?: string;
  autoPrepare?: boolean;
}

export interface ArchiverProviderExecution {
  report: ArchiverProviderRunReport;
  shouldRunBuiltin: boolean;
  builtinRequired: boolean;
}

/** 角色进程与 Daemon 之间共享的 CodeGraph 语义契约。 */
export interface ArchiverProviderCoordinator {
  getAutomaticStrategy(): ArchiverProviderExecutionStrategy;
  hasProjectKnowledgeSource(
    project: Project,
    archiveRoot: string,
    strategy?: ArchiverProviderExecutionStrategy
  ): Promise<boolean>;
  loadProjectKnowledgeContext(
    project: Project,
    archiveRoot: string,
    strategy?: ArchiverProviderExecutionStrategy,
    request?: ArchiverProviderContextRequest
  ): Promise<string>;
  queryProjectKnowledge(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy,
    request: ArchiverProviderQueryRequest
  ): Promise<string[]>;
  syncProject(
    project: Project,
    archiveRoot: string,
    strategy?: ArchiverProviderExecutionStrategy
  ): Promise<ArchiverProviderExecution>;
  finalizeBuiltin(
    project: Project,
    archiveRoot: string,
    report: ArchiverProviderRunReport,
    success: boolean,
    message: string
  ): Promise<void>;
}

/** 统一编排 Provider 的选择、回退和增强阶段，不直接理解各 Provider 的 CLI */
export class ArchiverProviderOrchestrator implements ArchiverProviderCoordinator {
  private readonly registry: ArchiverProviderRegistry;
  private readonly shell: ProviderCommandRunner;
  private readonly provisioner: ArchiverProviderProvisioner;
  private readonly autoPrepare: boolean;

  constructor(options: ArchiverProviderOrchestratorOptions = {}) {
    this.registry = options.registry ?? createDefaultArchiverProviderRegistry();
    this.shell = options.shell ?? new ProviderShell();
    this.provisioner =
      options.provisioner ??
      new ManagedProviderRuntime({
        rootDir: options.providerRuntimeRoot,
        shell: this.shell,
      });
    this.autoPrepare = options.autoPrepare ?? true;
  }

  listProviders(): ArchiverProviderDescriptor[] {
    return this.registry.listDescriptors();
  }

  /** 返回当前 Registry 计算出的系统策略，不写入项目配置。 */
  getAutomaticStrategy(): ArchiverProviderExecutionStrategy {
    return this.registry.createAutomaticStrategy();
  }

  /** 由 CodeGraph Server 在后台准备单个 Provider 的应用私有运行时。 */
  async prepareProvider(providerId: string): Promise<ArchiverProviderPrepareResult> {
    const adapter = this.registry.get(providerId);
    if (!adapter) {
      return {
        providerId,
        success: false,
        prepared: false,
        message: '未注册对应的 Provider Adapter',
      };
    }
    if (adapter.descriptor.kind === 'builtin') {
      return {
        providerId,
        success: true,
        prepared: true,
        message: '内置 Provider 已就绪',
      };
    }
    if (!adapter.descriptor.managedRuntime) {
      return {
        providerId,
        success: false,
        prepared: false,
        manual: adapter.descriptor.automation === 'manual',
        message: 'Provider 未声明可自动准备的托管运行时',
      };
    }
    return this.provisioner.prepare(adapter.descriptor);
  }

  async probeProject(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy()
  ): Promise<ArchiverProviderProbeResult[]> {
    const providerDataRoot = join(archiveRoot, 'providers');
    await mkdir(providerDataRoot, { recursive: true });
    const context: ArchiverProviderSyncContext = { project, archiveRoot, providerDataRoot };
    const providerIds = uniqueIds([
      ...this.registry.listDescriptors().map(descriptor => descriptor.id),
      strategy.primary,
      ...strategy.fallbacks,
      ...strategy.enrichers,
    ]);

    const results: ArchiverProviderProbeResult[] = [];
    for (const providerId of providerIds) {
      const adapter = this.registry.get(providerId);
      if (!adapter) {
        results.push({
          providerId,
          available: false,
          readiness: 'unavailable',
          message: '未注册对应的 Provider Adapter',
        });
        continue;
      }
      try {
        results.push(
          await this.probeWithPreparation(context, adapter, strategy.overrides?.[providerId])
        );
      } catch (error) {
        results.push({
          providerId,
          available: false,
          readiness: 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async readStatus(archiveRoot: string): Promise<ArchiverProviderRunReport | null> {
    try {
      const raw = await readFile(join(archiveRoot, 'providers', 'status.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return isArchiverProviderRunReport(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async hasProjectKnowledgeSource(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy()
  ): Promise<boolean> {
    const entries = await this.getKnowledgeAdapters(project, archiveRoot, strategy);
    return entries.some(({ adapter }) => typeof adapter.query === 'function');
  }

  async loadProjectKnowledgeContext(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy(),
    request: ArchiverProviderContextRequest = {}
  ): Promise<string> {
    const context = this.createSyncContext(project, archiveRoot);
    const entries = await this.getKnowledgeAdapters(project, archiveRoot, strategy);
    const sections = await Promise.all(
      entries.map(async ({ adapter, override }) => {
        if (!adapter.loadContext) return '';
        try {
          const result = await adapter.loadContext(
            context,
            this.createRuntime(),
            request,
            override
          );
          const content = result.success ? result.content?.trim() : '';
          return content ? `### ${adapter.descriptor.displayName}\n${content}` : '';
        } catch (error) {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              providerId: adapter.descriptor.id,
              projectId: project.id,
            },
            'Archiver Provider 上下文加载失败'
          );
          return '';
        }
      })
    );
    const maxChars = request.maxChars ?? 8000;
    return capKnowledgeItems(sections, sections.length || 1, maxChars).join('\n\n');
  }

  async queryProjectKnowledge(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy(),
    request: ArchiverProviderQueryRequest
  ): Promise<string[]> {
    if (!request.query.trim()) return [];
    const context = this.createSyncContext(project, archiveRoot);
    const entries = await this.getKnowledgeAdapters(project, archiveRoot, strategy);
    const results = await Promise.all(
      entries.map(async ({ adapter, override }) => {
        if (!adapter.query) return [];
        try {
          const result = await adapter.query(context, this.createRuntime(), request, override);
          if (!result.success) return [];
          return result.items.map(item => `[${adapter.descriptor.displayName}] ${item}`);
        } catch (error) {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              providerId: adapter.descriptor.id,
              projectId: project.id,
            },
            'Archiver Provider 查询失败'
          );
          return [];
        }
      })
    );
    return capKnowledgeItems(results.flat(), request.limit ?? 8, request.maxChars ?? 12000);
  }

  async syncProject(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy = this.getAutomaticStrategy()
  ): Promise<ArchiverProviderExecution> {
    const providerDataRoot = join(archiveRoot, 'providers');
    await mkdir(providerDataRoot, { recursive: true });
    const context: ArchiverProviderSyncContext = { project, archiveRoot, providerDataRoot };
    const report: ArchiverProviderRunReport = {
      schemaVersion: 1,
      projectId: project.id,
      generatedAt: Date.now(),
      selectedPrimary: '',
      statuses: [],
    };
    let shouldRunBuiltin = false;
    let builtinRequired = false;

    const candidates = uniqueIds([strategy.primary, ...strategy.fallbacks]);
    for (let index = 0; index < candidates.length; index += 1) {
      const providerId = candidates[index];
      const placement: ArchiverProviderPlacement = index === 0 ? 'primary' : 'fallback';
      if (providerId === BUILTIN_ARCHIVER_PROVIDER_ID) {
        report.selectedPrimary = providerId;
        shouldRunBuiltin = true;
        builtinRequired = true;
        report.statuses.push(this.deferredBuiltinStatus(placement));
        break;
      }

      const status = await this.runProvider(context, providerId, placement, strategy);
      report.statuses.push(status);
      if (status.state === 'completed') {
        report.selectedPrimary = providerId;
        break;
      }
    }

    if (!report.selectedPrimary && strategy.builtinFallback) {
      report.selectedPrimary = BUILTIN_ARCHIVER_PROVIDER_ID;
      shouldRunBuiltin = true;
      builtinRequired = true;
      report.statuses.push(this.deferredBuiltinStatus('fallback'));
    }

    if (report.selectedPrimary) {
      for (const providerId of uniqueIds(strategy.enrichers)) {
        if (providerId === report.selectedPrimary) continue;
        if (providerId === BUILTIN_ARCHIVER_PROVIDER_ID) {
          shouldRunBuiltin = true;
          report.statuses.push(this.deferredBuiltinStatus('enricher'));
          continue;
        }
        report.statuses.push(await this.runProvider(context, providerId, 'enricher', strategy));
      }
    }

    await this.writeReport(context, report);
    return { report, shouldRunBuiltin, builtinRequired };
  }

  async finalizeBuiltin(
    project: Project,
    archiveRoot: string,
    report: ArchiverProviderRunReport,
    success: boolean,
    message: string
  ): Promise<void> {
    const now = Date.now();
    for (const status of report.statuses) {
      if (status.providerId !== BUILTIN_ARCHIVER_PROVIDER_ID || status.state !== 'deferred')
        continue;
      status.state = success ? 'completed' : 'failed';
      status.finishedAt = now;
      status.message = message;
    }
    report.generatedAt = now;
    await this.writeReport(
      {
        project,
        archiveRoot,
        providerDataRoot: join(archiveRoot, 'providers'),
      },
      report
    );
  }

  private async runProvider(
    context: ArchiverProviderSyncContext,
    providerId: string,
    placement: ArchiverProviderPlacement,
    strategy: ArchiverProviderExecutionStrategy
  ): Promise<ArchiverProviderRunStatus> {
    const startedAt = Date.now();
    const adapter = this.registry.get(providerId);
    if (!adapter) {
      return {
        providerId,
        placement,
        state: 'unavailable',
        startedAt,
        finishedAt: Date.now(),
        message: '未注册对应的 Provider Adapter',
      };
    }
    if (!adapter.descriptor.placements.includes(placement)) {
      return {
        providerId,
        placement,
        state: 'skipped',
        startedAt,
        finishedAt: Date.now(),
        message: `Provider 不支持 ${placement} 位置`,
      };
    }
    const override = strategy.overrides?.[providerId];
    try {
      const probe = await this.probeWithPreparation(context, adapter, override);
      if (adapter.descriptor.automation === 'manual') {
        const readyForAgent = Boolean(probe.prepared || probe.available);
        return {
          providerId,
          placement,
          state: readyForAgent ? 'deferred' : 'unavailable',
          startedAt,
          finishedAt: Date.now(),
          version: probe.version,
          message: readyForAgent
            ? 'Skill 已自动准备，等待 Agent 工作流执行'
            : (probe.message ?? '该 Provider 需要 Agent 工作流执行'),
        };
      }
      if (!probe.available) {
        return {
          providerId,
          placement,
          state: 'unavailable',
          startedAt,
          finishedAt: Date.now(),
          message: probe.message,
        };
      }

      const result = await adapter.sync(context, this.createRuntime(), override);
      return {
        providerId,
        placement,
        state: result.success ? (result.skipped ? 'skipped' : 'completed') : 'failed',
        startedAt,
        finishedAt: Date.now(),
        version: probe.version,
        message: result.message,
        artifacts: result.artifacts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { err: message, providerId, projectId: context.project.id },
        'Archiver Provider 执行失败'
      );
      return {
        providerId,
        placement,
        state: 'failed',
        startedAt,
        finishedAt: Date.now(),
        message,
      };
    }
  }

  private createSyncContext(project: Project, archiveRoot: string): ArchiverProviderSyncContext {
    return {
      project,
      archiveRoot,
      providerDataRoot: join(archiveRoot, 'providers'),
    };
  }

  private async getKnowledgeAdapters(
    project: Project,
    archiveRoot: string,
    strategy: ArchiverProviderExecutionStrategy
  ): Promise<
    Array<{
      adapter: ArchiverProviderAdapter;
      override: ArchiverProviderOverride | undefined;
    }>
  > {
    const report = await this.readStatus(archiveRoot);
    if (report && report.projectId !== project.id) return [];
    const completedIds = new Set(
      (report?.statuses ?? [])
        .filter(status => status.state === 'completed')
        .map(status => status.providerId)
    );
    const providerIds = report
      ? uniqueIds([report.selectedPrimary, ...report.statuses.map(status => status.providerId)])
      : uniqueIds([strategy.primary, ...strategy.fallbacks, ...strategy.enrichers]);
    const passiveProviderIds = this.registry
      .listDescriptors()
      .filter(
        descriptor => descriptor.automation === 'manual' && descriptor.capabilities.includes('query')
      )
      .map(descriptor => descriptor.id);
    const knowledgeProviderIds = uniqueIds([...providerIds, ...passiveProviderIds]);
    const context = this.createSyncContext(project, archiveRoot);
    const entries = await Promise.all(
      knowledgeProviderIds.map(async providerId => {
        const adapter = this.registry.get(providerId);
        if (!adapter) return null;
        // 尚无编排状态时仅允许内置源和被动 Skill 产物，避免角色查询启动外部 CLI。
        if (
          !report &&
          adapter.descriptor.kind !== 'builtin' &&
          adapter.descriptor.automation !== 'manual'
        ) {
          return null;
        }
        const override = strategy.overrides?.[providerId];
        const completed = completedIds.has(providerId);
        if (completed) return { adapter, override };
        if (!adapter.isReady) return null;
        try {
          return (await adapter.isReady(context, this.createRuntime(), override))
            ? { adapter, override }
            : null;
        } catch {
          return null;
        }
      })
    );
    return entries.filter(
      (
        entry
      ): entry is {
        adapter: ArchiverProviderAdapter;
        override: ArchiverProviderOverride | undefined;
      } => entry !== null
    );
  }

  private deferredBuiltinStatus(placement: ArchiverProviderPlacement): ArchiverProviderRunStatus {
    const now = Date.now();
    return {
      providerId: BUILTIN_ARCHIVER_PROVIDER_ID,
      placement,
      state: 'deferred',
      startedAt: now,
      finishedAt: now,
      message: '等待 Archiver 内置知识提炼阶段执行',
    };
  }

  private createRuntime() {
    return { shell: this.shell, provisioner: this.provisioner };
  }

  private async probeWithPreparation(
    context: ArchiverProviderSyncContext,
    adapter: ArchiverProviderAdapter,
    override: ArchiverProviderOverride | undefined
  ): Promise<ArchiverProviderProbeResult> {
    let probe = await adapter.probe(context, this.createRuntime(), override);
    if (
      probe.available ||
      !this.autoPrepare ||
      !adapter.prepare ||
      !adapter.descriptor.managedRuntime
    ) {
      return probe;
    }

    const preparation = await adapter.prepare(context, this.createRuntime(), override);
    if (!preparation.success) {
      return {
        ...probe,
        readiness: adapter.descriptor.automation === 'manual' ? 'manual' : 'unavailable',
        prepared: false,
        version: preparation.version ?? probe.version,
        message: preparation.message ?? probe.message,
      };
    }

    probe = await adapter.probe(context, this.createRuntime(), override);
    return {
      ...probe,
      prepared: preparation.prepared || probe.prepared,
      version: probe.version ?? preparation.version,
      message: probe.message ?? preparation.message,
    };
  }

  private async writeReport(
    context: ArchiverProviderSyncContext,
    report: ArchiverProviderRunReport
  ): Promise<void> {
    await mkdir(context.providerDataRoot, { recursive: true });
    await writeFile(
      join(context.providerDataRoot, 'status.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );
  }
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const normalized = id.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isArchiverProviderRunReport(value: unknown): value is ArchiverProviderRunReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<ArchiverProviderRunReport>;
  if (
    report.schemaVersion !== 1 ||
    typeof report.projectId !== 'string' ||
    !Number.isFinite(report.generatedAt) ||
    typeof report.selectedPrimary !== 'string' ||
    !Array.isArray(report.statuses)
  ) {
    return false;
  }
  const placements = new Set<ArchiverProviderPlacement>(['primary', 'fallback', 'enricher']);
  const states = new Set<ArchiverProviderRunStatus['state']>([
    'selected',
    'completed',
    'unavailable',
    'failed',
    'skipped',
    'deferred',
  ]);
  return report.statuses.every(status => {
    if (!status || typeof status !== 'object') return false;
    return (
      typeof status.providerId === 'string' &&
      placements.has(status.placement) &&
      states.has(status.state) &&
      Number.isFinite(status.startedAt) &&
      Number.isFinite(status.finishedAt)
    );
  });
}
