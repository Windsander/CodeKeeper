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
export type ArchiveActionType = 'move' | 'merge' | 'create' | 'ignore' | 'flag';

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
  /** 建议说明 */
  reason: string;
  /** 目标路径（move/create 时使用） */
  targetPath?: string;
  /** 关联的已有条目 ID（merge 时使用） */
  relatedEntryId?: string;
  /** 风险等级：low 自动执行，medium/high 写入 suggestions.md */
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
  /** 健康度 0-1 */
  healthScore: number;
  /** 健康度计算说明 */
  healthScoreDefinition: string;
  /** 当前建议数量 */
  suggestionCount: number;
}
