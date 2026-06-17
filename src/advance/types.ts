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
  /** GitLab 配置（可选） */
  gitlab?: GitlabConfig;
  /** MR 评审配置（可选） */
  mrReview?: MrReviewConfig;
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
 * MR 自动评审配置
 */
export interface MrReviewConfig {
  /** 是否启用 MR 自动评审 */
  enabled: boolean;
  /** 自动合并模式：full 全自动 / audit 仅审计 */
  autoMergeMode: 'full' | 'audit';
  /** 评审调度 Cron 表达式 */
  reviewSchedule: string;
  /** 是否启用学习模式 */
  learningEnabled: boolean;
  /** 允许自动合并的最大风险等级 */
  maxAutoMergeRisk: 'LOW' | 'MEDIUM' | 'HIGH';
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
export type KnowledgeStatus = 'pending' | 'archived' | 'ignored';

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
