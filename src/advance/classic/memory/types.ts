/**
 * 记忆上下文：用于自动注入 EverOS 的 ID 维度
 */
export interface MemoryContext {
  /** 应用标识 */
  appId: string;
  /** 项目标识 */
  projectId: string;
  /** 角色标识（已清洗为 EverOS 安全字符集） */
  agentId: string;
  /** 角色显示名称（可能包含中文等 EverOS 不支持的字符） */
  agentDisplayName?: string;
  /** 远端用户标识；无明确用户时为 codekeeper-system */
  userId: string;
  /** 会话标识：单个 MR / Issue / 独立讨论主题 */
  sessionId: string;
}

/**
 * 项目知识条目
 */
export interface ProjectKnowledgeItem {
  id: string;
  category: 'convention' | 'architecture' | 'domain' | 'risk' | 'stack' | 'graph';
  sourceFiles: string[];
  content: string;
  confidence: 'low' | 'medium' | 'high';
  relations?: Array<{ targetId: string; relation: string }>;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/** 远端 review/comment 条目 */
export interface MemoryReviewComment {
  /** 评论作者 */
  author: string;
  /** 评论正文 */
  body: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
}

/**
 * 将任意 ID 清洗为 EverOS 路径安全字符集
 * 允许：字母、数字、_.@+-；替换其他字符为下划线，并排除 ".."
 */
export function sanitizeEverOSId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.@+-]/g, '_');
  return safe === '.' || safe === '..' ? '_' : safe;
}

/**
 * 为字符串生成稳定的短哈希，用于区分清洗后相同的安全 ID。
 * 相同原始字符串在不同调用间得到相同结果。
 */
function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 8);
}

/**
 * 构建 EverOS 安全的 Agent ID，同时保留可读的显示名称。
 *
 * 对于中文等 EverOS 不支持的字符，会先清洗成下划线，再追加原始名称的短哈希，
 * 避免不同中文名清洗后产生碰撞。显示名称通过 MemoryContext.agentDisplayName 单独传递。
 */
export function buildEverOSAgentId(role: string, displayName: string): string {
  const safeRole = sanitizeEverOSId(role);
  const safeName = sanitizeEverOSId(displayName);
  const hash = shortHash(displayName);
  return `${safeRole}-${safeName}-${hash}`;
}

/**
 * 为系统/占位角色构建 Agent ID（不需要显示名称映射时使用）。
 */
export function buildEverOSAgentIdFromRole(role: string): string {
  return sanitizeEverOSId(role);
}

/**
 * 写入记忆时的 finding 快照
 * 与 provider 层的 ReviewFinding 保持字段兼容，但不直接依赖 provider 类型。
 */
export interface MemoryFinding {
  severity: string;
  file: string;
  line: number;
  message: string;
  suggestion?: string;
  ruleId?: string;
  autoFixable?: boolean;
}

/**
 * 记忆客户端接口
 * Reviewer/Maintainer/Archiver 通过它读写记忆
 */
export interface IMemoryClient {
  readonly context: MemoryContext;

  recordReview(input: {
    mrIid: number;
    title: string;
    findingsCount: number;
    summary: string;
    /** 评审发现的简要列表（可选） */
    findings?: Array<MemoryFinding>;
    /** 远端已有的 review/comment 列表（可选），会作为 user 消息写入记忆 */
    comments?: MemoryReviewComment[];
    /** MR 作者用户名，用于无评论时作为 user 锚点 sender */
    mrAuthor?: string;
  }): Promise<void>;

  recordFixAttempt(input: {
    mrIid: number;
    file: string;
    line: number;
    success: boolean;
    reason?: string;
  }): Promise<void>;

  recordInteraction(input: {
    discussionId: string;
    userId: string;
    decision: string;
    outcome: string;
  }): Promise<void>;

  recordProjectKnowledge(items: ProjectKnowledgeItem[]): Promise<void>;

  recallForReview(query: string): Promise<string[]>;
  recallForMaintenance(query: string): Promise<string[]>;
  recallProjectKnowledge(query: string): Promise<string[]>;
  recallUserPreferences(userId: string, query: string): Promise<string[]>;
}
