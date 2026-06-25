/**
 * 记忆上下文：用于自动注入 EverOS 的 ID 维度
 */
export interface MemoryContext {
  /** 应用标识 */
  appId: string;
  /** 项目标识 */
  projectId: string;
  /** 角色标识 */
  agentId: string;
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

/**
 * 将任意 ID 清洗为 EverOS 路径安全字符集
 * 允许：字母、数字、_.@+-；替换其他字符为下划线，并排除 ".."
 */
export function sanitizeEverOSId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.@+-]/g, '_');
  return safe === '.' || safe === '..' ? '_' : safe;
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
    findings?: Array<Record<string, unknown>>;
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
