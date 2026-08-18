import type { Project, Role } from '../types.js';

/** Provider 内部选项值，不进入项目持久化配置。 */
export type ArchiverProviderOptionValue = string | number | boolean;

/** Provider 内部运行覆盖，不通过项目配置或 UI 暴露。 */
export interface ArchiverProviderOverride {
  launchPreset?: string;
  executable?: string;
  argsPrefix?: string[];
  timeoutMs?: number;
  inheritEnv?: string[];
  env?: Record<string, string>;
  options?: Record<string, ArchiverProviderOptionValue>;
}

/** 编排器内部执行策略，与 Archiver 持久化配置隔离。 */
export interface ArchiverProviderExecutionStrategy {
  schemaVersion: 1;
  primary: string;
  fallbacks: string[];
  enrichers: string[];
  builtinFallback: boolean;
  overrides?: Record<string, ArchiverProviderOverride>;
}

/** Provider 能力标识，供编排器和角色上下文层做能力协商 */
export type ArchiverProviderCapability =
  | 'code-structure'
  | 'documents'
  | 'query'
  | 'impact-analysis'
  | 'git-history'
  | 'code-health'
  | 'interactive-skill';

/** Provider 自动化接入等级 */
export type ArchiverProviderAutomation = 'full' | 'managed' | 'manual';

/** Provider 运行时准备方式，由系统托管，不进入项目配置。 */
export type ArchiverProviderManagedRuntime =
  | {
      kind: 'python-package';
      packageName: string;
      version: string;
      entrypoint: string;
    }
  | {
      kind: 'npm-package';
      packageName: string;
      version: string;
      entrypoint: string;
    }
  | {
      kind: 'git-skill';
      repository: string;
      revision: string;
      version: string;
      skillPath: string;
    };

/** Provider 对 UI 暴露的准备能力，不暴露包名、命令或本机路径。 */
export type ArchiverProviderPreparation = 'builtin' | 'managed' | 'manual';

/** Provider 当前可执行状态。 */
export type ArchiverProviderReadiness =
  | 'ready'
  | 'preparable'
  | 'preparing'
  | 'manual'
  | 'unavailable';

/** Provider 可承担的组合位置 */
export type ArchiverProviderPlacement = 'primary' | 'fallback' | 'enricher';

/** Provider 的标准启动方式，包管理器差异不进入具体命令语义 */
export interface ArchiverProviderLaunchPreset {
  id: string;
  displayName: string;
  description?: string;
  executable: string;
  argsPrefix: string[];
  /** 该启动器运行所需、由 Adapter 显式声明继承的宿主环境变量 */
  inheritEnv?: string[];
}

/** Provider 自有选项的 UI 描述，由 Adapter 负责解释具体语义 */
export interface ArchiverProviderOptionDescriptor {
  key: string;
  displayName: string;
  description?: string;
  type: 'boolean' | 'number' | 'string';
  defaultValue: string | number | boolean;
}

/** 对 UI 和编排器公开的 Provider 元数据 */
export interface ArchiverProviderDescriptor {
  id: string;
  displayName: string;
  description: string;
  homepage: string;
  license: string;
  kind: 'builtin' | 'cli' | 'skill';
  automation: ArchiverProviderAutomation;
  placements: ArchiverProviderPlacement[];
  capabilities: ArchiverProviderCapability[];
  /** 是否参与系统自动遴选；仅供内部 Registry 使用。 */
  autoSelect?: boolean;
  /** 同一位置下的系统优先级，数值越大越优先。 */
  selectionPriority?: number;
  defaultExecutable?: string;
  defaultLaunchPreset?: string;
  launchPresets?: ArchiverProviderLaunchPreset[];
  options?: ArchiverProviderOptionDescriptor[];
  licenseNotice?: string;
  /** 系统托管运行时描述，仅供主进程准备 Provider。 */
  managedRuntime?: ArchiverProviderManagedRuntime;
}

/** Provider 探测状态 */
export interface ArchiverProviderProbeResult {
  providerId: string;
  available: boolean;
  readiness?: ArchiverProviderReadiness;
  prepared?: boolean;
  executable?: string;
  version?: string;
  message?: string;
}

/** 托管运行时解析出的 CLI 启动信息。 */
export interface ArchiverProviderManagedInvocation {
  executable: string;
  argsPrefix: string[];
  env?: Record<string, string>;
  inheritEnv?: string[];
  version: string;
}

/** Provider 自动准备结果。 */
export interface ArchiverProviderPrepareResult {
  providerId: string;
  success: boolean;
  prepared: boolean;
  manual?: boolean;
  version?: string;
  message?: string;
  invocation?: ArchiverProviderManagedInvocation;
  assetRoot?: string;
}

/** Provider 托管运行时能力。 */
export interface ArchiverProviderProvisioner {
  resolve(descriptor: ArchiverProviderDescriptor): Promise<ArchiverProviderPrepareResult | null>;
  prepare(descriptor: ArchiverProviderDescriptor): Promise<ArchiverProviderPrepareResult>;
}

/** Provider 单次同步结果 */
export interface ArchiverProviderSyncResult {
  providerId: string;
  success: boolean;
  skipped?: boolean;
  message?: string;
  artifacts?: string[];
  metadata?: Record<string, string | number | boolean>;
}

/** Provider 静态上下文请求 */
export interface ArchiverProviderContextRequest {
  maxChars?: number;
}

/** Provider 静态上下文结果 */
export interface ArchiverProviderContextResult {
  providerId: string;
  success: boolean;
  content?: string;
  message?: string;
}

/** Provider 项目知识查询请求 */
export interface ArchiverProviderQueryRequest {
  query: string;
  role?: Role;
  limit?: number;
  maxChars?: number;
}

/** Provider 项目知识查询结果 */
export interface ArchiverProviderQueryResult {
  providerId: string;
  success: boolean;
  items: string[];
  message?: string;
}

/** Provider 同步上下文 */
export interface ArchiverProviderSyncContext {
  project: Project;
  archiveRoot: string;
  providerDataRoot: string;
}

/** 编排器记录的单个 Provider 状态 */
export interface ArchiverProviderRunStatus {
  providerId: string;
  placement: ArchiverProviderPlacement;
  state: 'selected' | 'completed' | 'unavailable' | 'failed' | 'skipped' | 'deferred';
  startedAt: number;
  finishedAt: number;
  version?: string;
  message?: string;
  artifacts?: string[];
}

/** 一轮 Provider 编排报告 */
export interface ArchiverProviderRunReport {
  schemaVersion: 1;
  projectId: string;
  generatedAt: number;
  selectedPrimary: string;
  statuses: ArchiverProviderRunStatus[];
}

/** Provider Adapter 运行时依赖 */
export interface ArchiverProviderRuntime {
  shell: import('./provider-shell.js').ProviderCommandRunner;
  provisioner?: ArchiverProviderProvisioner;
}

/** Provider Adapter 协议 */
export interface ArchiverProviderAdapter {
  readonly descriptor: ArchiverProviderDescriptor;
  prepare?(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderPrepareResult>;
  probe(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderProbeResult>;
  sync(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult>;
  /** 判断已有归档产物是否足以提供查询/上下文，允许上一轮成功结果继续可用。 */
  isReady?(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<boolean>;
  loadContext?(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    request: ArchiverProviderContextRequest,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderContextResult>;
  query?(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    request: ArchiverProviderQueryRequest,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderQueryResult>;
}
