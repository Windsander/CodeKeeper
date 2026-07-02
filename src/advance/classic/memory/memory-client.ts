import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { logger } from '../../../core/logger.js';
import type { IMemoryClient, MemoryContext, MemoryFinding, ProjectKnowledgeItem } from './types.js';
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
    findings?: Array<MemoryFinding>;
    comments?: Array<{ author: string; body: string; createdAt: string }>;
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
    await this.callTool('record_fix_attempt', { ...input, context: this.context });
  }

  async recordInteraction(input: {
    discussionId: string;
    userId: string;
    decision: string;
    outcome: string;
  }): Promise<void> {
    await this.callTool('record_interaction', { ...input, context: this.context });
  }

  async recordProjectKnowledge(items: ProjectKnowledgeItem[]): Promise<void> {
    await this.callTool('record_project_knowledge', { context: this.context, items });
  }

  async recallForReview(query: string): Promise<string[]> {
    return this.parseRecallResult(await this.callTool('recall_for_review', { context: this.context, query }));
  }

  async recallForMaintenance(query: string): Promise<string[]> {
    return this.parseRecallResult(await this.callTool('recall_for_maintenance', { context: this.context, query }));
  }

  async recallProjectKnowledge(query: string): Promise<string[]> {
    return this.parseRecallResult(await this.callTool('recall_project_knowledge', { context: this.context, query }));
  }

  async recallUserPreferences(userId: string, query: string): Promise<string[]> {
    return this.parseRecallResult(
      await this.callTool('recall_user_preferences', { context: this.context, userId, query })
    );
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content?: Array<{ type: string; text?: string }> } | undefined> {
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const cast = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      if (cast.isError) {
        const message = cast.content?.[0]?.text ?? 'MCP tool 返回错误';
        logger.error({ tool: name, result }, `MemoryClient 调用 ${name} 失败`);
        throw new Error(`MemoryClient ${name} 失败: ${message}`);
      }
      return cast;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, tool: name }, `MemoryClient 调用 ${name} 失败`);
      throw new Error(`MemoryClient ${name} 失败: ${message}`);
    }
  }

  private parseRecallResult(result: { content?: Array<{ type: string; text?: string }> } | undefined): string[] {
    const text = result?.content?.[0]?.text ?? '';
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as { results?: string[] };
      return Array.isArray(parsed.results) ? parsed.results : [];
    } catch {
      return [];
    }
  }
}
