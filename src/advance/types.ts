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
