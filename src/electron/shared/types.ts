/**
 * Electron 渲染进程与主进程共享的类型定义
 * 注意：这些类型与 src/advance 中的类型保持同步，避免 Electron tsconfig 引用 advance 源文件。
 */

export interface IpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface IpcError {
  code: string;
  message: string;
}

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: IpcError;
}

export interface IpcPushEvent {
  type: 'push';
  event: string;
  payload: unknown;
}

export type IpcMessage = IpcResponse | IpcPushEvent;

export function isIpcResponse(msg: IpcMessage): msg is IpcResponse {
  return 'id' in msg;
}

export function isIpcPushEvent(msg: IpcMessage): msg is IpcPushEvent {
  return 'type' in msg && msg.type === 'push';
}

export type ArchiveActionType = 'copy' | 'organize' | 'ignore' | 'flag';

export interface ArchiveAction {
  id: string;
  sourcePath: string;
  type: ArchiveActionType;
  reason: string;
  targetPath?: string;
  relatedEntryId?: string;
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  createdAt: number;
}

export interface ProjectStatus {
  schemaVersion: number;
  projectId: string;
  lastScannedAt: number;
  lastScannedAtIso: string;
  scanStatus: 'success' | 'partial' | 'failed';
  totalCount: number;
  pendingCount: number;
  archivedCount: number;
  ignoredCount: number;
  orphanedCount: number;
  copiedCount: number;
  organizedCount: number;
  flaggedCount: number;
  healthScore: number;
  healthScoreDefinition: string;
}

// ==================== Role Plugin Types ====================

/**
 * Electron 渲染进程与主进程共享的记忆查询类型
 */

export type MemoryEntryType = 'agent_case' | 'episode' | 'agent_skill' | 'profile';

export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  content: string;
  source: string;
  timestamp: string;
  sessionId: string;
  score?: number;
}

export interface MemorySearchParams {
  projectId: string;
  agentId?: string;
  userId?: string;
  query?: string;
  limit?: number;
}

export interface MemorySearchResult {
  entries: MemoryEntry[];
}

export interface MemoryDeleteParams {
  projectId: string;
  sessionId: string;
}

/**
 * 角色标识
 */
export type Role = 'reviewer' | 'maintainer' | 'archiver';

/**
 * 角色过滤条件
 */
export interface RoleFilter {
  conditions: Array<{
    field: 'author' | 'assignee' | 'reviewer' | 'label' | 'sourceBranch' | 'targetBranch' | 'draft';
    values: string[];
  }>;
}

/**
 * GitLab 仓库配置
 */
export interface GitlabConfig {
  baseUrl: string;
  projectPath: string;
  token: string;
  defaultBranch?: string;
}

/**
 * Reviewer 专属配置
 */
export interface ReviewerConfig {
  role: 'reviewer';
  enabled: boolean;
  reviewSchedule: string;
  learningEnabled: boolean;
  filter?: RoleFilter;
}

/**
 * Maintainer 专属配置
 */
export interface MaintainerConfig {
  role: 'maintainer';
  enabled: boolean;
  reviewSchedule: string;
  learningEnabled: boolean;
  maintainerName: string;
  autoFixEnabled: boolean;
  /** 允许自动修复的风险等级，未配置时默认全部允许 */
  autoFixRiskLevels?: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>;
  resolveOthersDiscussions: boolean;
  filter?: RoleFilter;
}

/**
 * 角色配置联合类型
 */
export type RoleConfig = ReviewerConfig | MaintainerConfig;

/**
 * 按角色索引的配置映射
 */
export type RoleConfigMap = Record<Role, RoleConfig>;

/**
 * 项目运行时元数据（渲染端使用的最小子集）
 */
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  gitlab?: GitlabConfig | null;
  roles?: RoleConfigMap;
}
