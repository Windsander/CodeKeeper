import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { logger } from '../../../core/logger.js';
import type { IMemoryClient, MemoryContext, ProjectKnowledgeItem } from './types.js';
import { sanitizeEverOSId } from './types.js';

export interface MemoryClientOptions {
  /** MCP server URL */
  mcpUrl: string;
  /** 默认记忆上下文 */
  context: MemoryContext;
}

/**
 * 通过 MCP Server 读写记忆
 */
export class MemoryClient implements IMemoryClient {
  private readonly mcpUrl: string;
  private client: Client;
  private transport: SSEClientTransport | null = null;
  readonly context: MemoryContext;

  constructor(options: MemoryClientOptions) {
    this.mcpUrl = options.mcpUrl;
    this.context = {
      appId: sanitizeEverOSId(options.context.appId),
      projectId: sanitizeEverOSId(options.context.projectId),
      agentId: sanitizeEverOSId(options.context.agentId),
      userId: sanitizeEverOSId(options.context.userId),
      sessionId: sanitizeEverOSId(options.context.sessionId),
    };
    this.client = new Client({ name: 'codekeeper-memory-client', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    this.transport = new SSEClientTransport(new URL('/sse', this.mcpUrl));
    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    await this.transport?.close();
    this.transport = null;
  }

  async recordReview(input: {
    mrIid: number;
    title: string;
    findingsCount: number;
    summary: string;
  }): Promise<void> {
    await this.callTool('record_review', { ...input, context: this.context });
  }

  async recordFixAttempt(input: {
    mrIid: number;
    file: string;
    line: number;
    success: boolean;
    reason?: string;
  }): Promise<void> {
    logger.debug(input, 'recordFixAttempt 待阶段二实现');
  }

  async recordInteraction(input: {
    discussionId: string;
    userId: string;
    decision: string;
    outcome: string;
  }): Promise<void> {
    logger.debug(input, 'recordInteraction 待阶段二实现');
  }

  async recordProjectKnowledge(items: ProjectKnowledgeItem[]): Promise<void> {
    await this.callTool('record_project_knowledge', { context: this.context, items });
  }

  async recallForReview(query: string): Promise<string[]> {
    logger.debug({ query }, 'recallForReview 待阶段二实现');
    return [];
  }

  async recallForMaintenance(query: string): Promise<string[]> {
    logger.debug({ query }, 'recallForMaintenance 待阶段二实现');
    return [];
  }

  async recallProjectKnowledge(query: string): Promise<string[]> {
    logger.debug({ query }, 'recallProjectKnowledge 待阶段二实现');
    return [];
  }

  async recallUserPreferences(userId: string, query: string): Promise<string[]> {
    logger.debug({ userId, query }, 'recallUserPreferences 待阶段二实现');
    return [];
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.client.callTool({ name, arguments: args });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, tool: name }, `MemoryClient 调用 ${name} 失败`);
      // 记忆写入失败不阻断主流程
      logger.warn({ tool: name, error: message }, '记忆写入失败，继续执行主流程');
    }
  }
}
