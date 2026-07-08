import { join } from 'node:path';

/**
 * 角色标识
 */
export type Role = 'reviewer' | 'maintainer' | 'archiver';

/**
 * 所有注册角色列表
 */
export const ROLES: Role[] = ['reviewer', 'maintainer', 'archiver'];

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
 * 所有角色共享的基础配置
 */
export interface BaseRoleConfig {
  enabled: boolean;
  reviewSchedule: string;
  learningEnabled: boolean;
  filter?: RoleFilter;
}

/**
 * Reviewer 专属配置
 */
export interface ReviewerConfig extends BaseRoleConfig {
  role: 'reviewer';
  /** Reviewer Agent 显示名称，用于评论签名 */
  reviewerName?: string;
  /** 需要创建代码行级 discussion thread 的严重等级，未配置时默认 CRITICAL + HIGH */
  threadRiskLevels?: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>;
}

/**
 * Maintainer 专属配置
 */
export interface MaintainerConfig extends BaseRoleConfig {
  role: 'maintainer';
  maintainerName: string;
  autoFixEnabled: boolean;
  /** 允许自动修复的风险等级，未配置时默认全部允许 */
  autoFixRiskLevels?: Array<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'>;
  resolveOthersDiscussions: boolean;
  /** 认知深度，默认 deep */
  cognitiveDepth?: 'fast' | 'standard' | 'deep';
}

/**
 * Archiver 专属配置
 */
export interface ArchiverConfig extends BaseRoleConfig {
  role: 'archiver';
  /** Archiver Agent 显示名称，用于日志/签名 */
  archiverName?: string;
}

/**
 * 角色配置联合类型
 */
export type RoleConfig = ReviewerConfig | MaintainerConfig | ArchiverConfig;

/**
 * 角色配置的类型映射，用于按角色窄化
 */
export type RoleConfigOf<R extends Role> = R extends 'reviewer'
  ? ReviewerConfig
  : R extends 'maintainer'
    ? MaintainerConfig
    : R extends 'archiver'
      ? ArchiverConfig
      : never;

/**
 * 角色项目运行状态
 */
export interface RoleProjectStatus {
  running: boolean;
  lastRunAt: number | null;
  lastError?: {
    type: 'missing-token' | 'invalid-token' | 'gitlab-api' | 'unknown';
    message: string;
    at: number;
  };
  lastSuccessAt?: number;
  agentStartedAt?: number;
  agentStoppedAt?: number;
}

// ---------- 兼容类型（后续任务将逐步迁移）----------

/**
 * @deprecated 使用 RoleFilter 替代
 */
export type MrReviewFilter = RoleFilter;

/**
 * @deprecated 使用 RoleFilter 中的 field 类型替代
 */
export type MrReviewFilterField = RoleFilter['conditions'][number]['field'];

/**
 * @deprecated 使用 RoleFilter 中的 condition 类型替代
 */
export interface MrReviewFilterCondition {
  field: MrReviewFilterField;
  values: string[];
}

/**
 * @deprecated 使用 ReviewerConfig 或 RoleConfig 替代
 */
export interface MrReviewConfig {
  enabled: boolean;
  agentRole: 'reviewer' | 'auto-fixer' | 'reviewer+auto-fixer';
  autoMergeMode: 'full' | 'audit';
  reviewSchedule: string;
  learningEnabled: boolean;
  maxAutoMergeRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  autoFixEnabled?: boolean;
  resolveOthersDiscussions?: boolean;
  filter?: MrReviewFilter;
}

/**
 * 已注册项目的运行时元数据（区别于 ProjectConfig 项目配置）
 */
export interface Project {
  /** 项目唯一标识，使用目录绝对路径的规范化形式 */
  id: string;
  /** 项目根目录绝对路径 */
  rootPath: string;
  /** 人类可读名称，默认取目录名 */
  name: string;
  /** 注册时间戳 */
  registeredAt: number;
  /** 最后扫描时间戳；null 表示从未扫描 */
  lastScannedAt: number | null;
  /** 归档位置；未设置时默认使用 <rootPath>/.codekeeper */
  archiveRoot?: string;
  /** GitLab 配置（可选） */
  gitlab?: GitlabConfig;
  /** 角色配置（新） */
  roles?: Record<Role, RoleConfig>;
  /** MR 评审配置（旧，后续迁移到 roles） */
  mrReview?: MrReviewConfig;
}

/** 获取项目归档目录 */
export function getArchiveRoot(project: Pick<Project, 'rootPath' | 'archiveRoot'>): string {
  return project.archiveRoot ?? join(project.rootPath, '.codekeeper');
}

/**
 * GitLab 仓库配置
 */
export interface GitlabConfig {
  /** GitLab 实例地址 */
  baseUrl: string;
  /** 项目路径，格式为 "group/project" */
  projectPath: string;
  /** 访问令牌 */
  token: string;
  /** 默认分支名 */
  defaultBranch?: string;
}

/**
 * MR 评审状态记录
 */
export interface MrReviewState {
  /** 唯一标识 */
  id: string;
  /** 所属项目 ID */
  projectId: string;
  /** MR 在 GitLab 中的 IID */
  mrIid: number;
  /** 源分支 */
  sourceBranch: string;
  /** 目标分支 */
  targetBranch: string;
  /** 当前状态 */
  state: string;
  /** MR 标题 */
  title?: string;
  /** MR 网页链接 */
  webUrl?: string;
  /** 评审发现（JSON 字符串） */
  findingsJson?: string;
  /** 修复分支名 */
  fixBranch?: string;
  /** 风险等级 */
  riskLevel?: string;
  /** 评审者评论数量 */
  reviewerCommentsCount: number;
  /** 未解决评论数量 */
  unresolvedCommentsCount: number;
  /** CI 状态 */
  ciStatus?: string;
  /** 最后评审者评论时间戳 */
  lastReviewerCommentAt?: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/**
 * 文件监听事件类型
 */
export type WatchEventType = 'add' | 'change' | 'unlink';

/**
 * 文件系统变更事件
 */
export interface WatchedEvent {
  /** 事件类型 */
  type: WatchEventType;
  /** 变更文件绝对路径 */
  filePath: string;
  /** 事件产生时间戳 */
  timestamp: number;
}

/**
 * 知识条目处理状态
 */
export type KnowledgeStatus = 'pending' | 'archived' | 'ignored' | 'orphaned';

/**
 * 文档分节摘要
 */
export interface DocumentSection {
  /** 节标题或关键句 */
  heading: string;
  /** 该节摘要 */
  summary: string;
  /** 置信度 0-1 */
  confidence: number;
}

/**
 * 文档分类结果
 */
export interface ClassificationResult {
  /** 领域分类，如 memory / sync / skill / review */
  category: string;
  /** 文档类型，如 design / spec / weekly / note */
  docType: string;
  /** 关键词标签 */
  tags: string[];
  /** 一句话摘要 */
  summary: string;
  /** 分节摘要；短文档可能为空 */
  sections: DocumentSection[];
  /** 置信度 0-1 */
  confidence: number;
}

/**
 * 归档动作类型
 */
export type ArchiveActionType = 'copy' | 'organize' | 'ignore' | 'flag';

/**
 * 单条归档建议/动作
 */
export interface ArchiveAction {
  /** 动作 ID */
  id: string;
  /** 源文件绝对路径 */
  sourcePath: string;
  /** 动作类型 */
  type: ArchiveActionType;
  /** 决策说明 / 理由 */
  reason: string;
  /** 目标路径（copy/organize/flag 时使用） */
  targetPath?: string;
  /** 关联的已有条目 ID（organize 时使用） */
  relatedEntryId?: string;
  /** 风险等级：仅用于日志和展示，不影响自动执行 */
  risk: 'low' | 'medium' | 'high';
  /** 置信度 0-1 */
  confidence: number;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 项目实时状态（写入 status.json）
 */
export interface ProjectStatus {
  /** schema 版本 */
  schemaVersion: number;
  /** 项目 ID */
  projectId: string;
  /** 最后扫描时间戳 */
  lastScannedAt: number;
  /** 最后扫描时间的 ISO 8601 表示 */
  lastScannedAtIso: string;
  /** 扫描结果状态：success / partial / failed */
  scanStatus: 'success' | 'partial' | 'failed';
  /** 总条目数 */
  totalCount: number;
  /** 未归档/待处理数量 */
  pendingCount: number;
  /** 已归档数量 */
  archivedCount: number;
  /** 忽略数量 */
  ignoredCount: number;
  /** 源文件已删除但归档副本保留的数量 */
  orphanedCount: number;
  /** 已复制到归档的数量 */
  copiedCount: number;
  /** 已在归档内重新组织的数量 */
  organizedCount: number;
  /** 标记为需要关注的数量 */
  flaggedCount: number;
  /** 健康度 0-1 */
  healthScore: number;
  /** 健康度计算说明 */
  healthScoreDefinition: string;
}

/**
 * 知识条目元数据；实际内容存储在文件系统中，此处只保存路径与内容哈希
 */
export interface KnowledgeEntry {
  /** 条目唯一标识，使用文件路径 + 版本哈希 */
  id: string;
  /** 所属项目 ID */
  projectId: string;
  /** 文件绝对路径 */
  filePath: string;
  /** 文件内容哈希（sha256 前 16 位） */
  contentHash: string;
  /** 当前处理状态 */
  status: KnowledgeStatus;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}
