import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import http, { type Server as HttpServer } from 'node:http';
import { URL } from 'node:url';
import { logger } from '../../../core/logger.js';
import { SecretSanitizer } from './secret-sanitizer.js';
import type { MemoryContext, ProjectKnowledgeItem } from './types.js';
import { sanitizeEverOSId } from './types.js';
import { everosMemoryAdd, everosMemoryAddMessages, everosMemorySearch, everosMemoryFlush, type EverOSSearchItem } from './everos-api.js';

export interface EverOSMcpServerOptions {
  /** EverOS HTTP API URL */
  everosUrl: string;
  /** 监听端口；0 表示随机 */
  port?: number;
}

/**
 * 将 EverOS 能力包装为语义化 MCP Server
 */
export class EverOSMcpServer {
  private server: Server;
  private httpServer: HttpServer | null = null;
  private readonly everosUrl: string;
  private readonly port: number;
  private readonly sanitizer = new SecretSanitizer();

  constructor(options: EverOSMcpServerOptions) {
    this.everosUrl = options.everosUrl;
    this.port = options.port ?? 0;

    this.server = new Server(
      {
        name: 'codekeeper-everos-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerTools();
  }

  /**
   * 启动 HTTP SSE 服务
   */
  async start(): Promise<string> {
    return new Promise((resolve) => {
      const transportMap = new Map<string, SSEServerTransport>();
      this.httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        if (url.pathname === '/sse') {
          const transport = new SSEServerTransport('/messages', res);
          transportMap.set(transport.sessionId, transport);
          res.on('close', () => transportMap.delete(transport.sessionId));
          await this.server.connect(transport);
          return;
        }

        if (url.pathname === '/messages') {
          const sessionId = url.searchParams.get('sessionId') ?? '';
          const transport = transportMap.get(sessionId);
          if (!transport) {
            res.writeHead(404);
            res.end('session not found');
            return;
          }
          await transport.handlePostMessage(req, res);
          return;
        }

        res.writeHead(404);
        res.end('not found');
      });

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        const addr = this.httpServer?.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer?.close(() => resolve());
    });
  }

  private registerTools(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'record_review',
          description: 'Reviewer 记录一次 MR 评审',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              mrIid: { type: 'number' },
              title: { type: 'string' },
              findingsCount: { type: 'number' },
              summary: { type: 'string' },
              findings: { type: 'array' },
              comments: {
                type: 'array',
                description: '远端已有的 review/comment 列表，会作为 user 消息写入记忆',
                items: {
                  type: 'object',
                  properties: {
                    author: { type: 'string' },
                    body: { type: 'string' },
                    createdAt: { type: 'string' },
                  },
                  required: ['author', 'body', 'createdAt'],
                },
              },
            },
            required: ['context', 'mrIid', 'title', 'findingsCount', 'summary'],
          },
        },
        {
          name: 'record_project_knowledge',
          description: 'Archiver 写入项目知识',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              items: { type: 'array' },
            },
            required: ['context', 'items'],
          },
        },
        {
          name: 'record_fix_attempt',
          description: 'Maintainer 记录一次修复尝试',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              mrIid: { type: 'number' },
              file: { type: 'string' },
              line: { type: 'number' },
              success: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['context', 'mrIid', 'file', 'line', 'success'],
          },
        },
        {
          name: 'record_interaction',
          description: '记录 Maintainer 与远端用户的交互',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              discussionId: { type: 'string' },
              userId: { type: 'string' },
              decision: { type: 'string' },
              outcome: { type: 'string' },
            },
            required: ['context', 'discussionId', 'userId', 'decision', 'outcome'],
          },
        },
        {
          name: 'recall_for_review',
          description: 'Reviewer 召回与本次 MR 相关的历史评审经验',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              query: { type: 'string' },
            },
            required: ['context', 'query'],
          },
        },
        {
          name: 'recall_for_maintenance',
          description: 'Maintainer 召回与本次维护相关的历史经验',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              query: { type: 'string' },
            },
            required: ['context', 'query'],
          },
        },
        {
          name: 'recall_project_knowledge',
          description: '召回与查询相关的项目知识',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              query: { type: 'string' },
            },
            required: ['context', 'query'],
          },
        },
        {
          name: 'recall_user_preferences',
          description: '召回指定用户的历史偏好与交互',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              userId: { type: 'string' },
              query: { type: 'string' },
            },
            required: ['context', 'userId', 'query'],
          },
        },
        {
          name: 'memory_delete',
          description: '按 session_id 标记删除记忆（软删除）',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              sessionId: { type: 'string' },
            },
            required: ['context', 'sessionId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.info({ tool: name }, '调用 MCP tool');

      try {
        if (name === 'record_review') {
          await this.handleRecordReview(args as { context: MemoryContext } & Record<string, unknown>);
          return this.okResult();
        }
        if (name === 'record_project_knowledge') {
          await this.handleRecordProjectKnowledge(
            (args as { context: MemoryContext }).context,
            (args as { items: ProjectKnowledgeItem[] }).items
          );
          return this.okResult();
        }
        if (name === 'record_fix_attempt') {
          await this.handleRecordFixAttempt(args as { context: MemoryContext } & Record<string, unknown>);
          return this.okResult();
        }
        if (name === 'record_interaction') {
          await this.handleRecordInteraction(args as { context: MemoryContext } & Record<string, unknown>);
          return this.okResult();
        }
        if (name === 'recall_for_review') {
          return this.recallResult(
            await this.handleRecallForReview(args as { context: MemoryContext; query: string })
          );
        }
        if (name === 'recall_for_maintenance') {
          return this.recallResult(
            await this.handleRecallForMaintenance(args as { context: MemoryContext; query: string })
          );
        }
        if (name === 'recall_project_knowledge') {
          return this.recallResult(
            await this.handleRecallProjectKnowledge(args as { context: MemoryContext; query: string })
          );
        }
        if (name === 'recall_user_preferences') {
          return this.recallResult(
            await this.handleRecallUserPreferences(
              args as { context: MemoryContext; userId: string; query: string }
            )
          );
        }
        if (name === 'memory_delete') {
          await this.handleMemoryDelete(args as { context: MemoryContext } & Record<string, unknown>);
          return this.okResult();
        }
        throw new Error(`未知 tool: ${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, tool: name }, 'MCP tool 调用失败');
        return this.errorResult(message);
      }
    });
  }

  private okResult(): CallToolResult {
    return { content: [{ type: 'text', text: 'ok' } as TextContent] };
  }

  private recallResult(items: EverOSSearchItem[]): CallToolResult {
    const maxResults = 5;
    const results = items
      .slice(0, maxResults)
      .map((item) => (item.source ? `${item.source}\n${item.content}` : item.content));
    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) } as TextContent],
    };
  }

  private errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: `error: ${message}` } as TextContent], isError: true };
  }

  private async handleRecordReview(args: { context: MemoryContext } & Record<string, unknown>): Promise<void> {
    const ctx = args.context;
    const summary = this.sanitizer.sanitize(String(args.summary ?? ''));
    const findings = Array.isArray(args.findings) ? args.findings : [];
    const comments = Array.isArray(args.comments) ? args.comments : [];
    const mrIid = String(args.mrIid ?? 0);
    const title = String(args.title ?? '');
    const findingsText = this.formatFindingsForMemory(findings);
    const reviewContent = `Reviewer 评审 MR !${mrIid}: ${title}。\n发现 ${String(args.findingsCount ?? 0)} 个问题。\n总结：${summary}\n\nFindings:\n${findingsText}`;

    const messages: import('./everos-api.js').EverOSAddMessage[] = [];

    // 先写入远端真人用户的 review/comment，作为 user 消息
    for (const raw of comments) {
      const comment = raw as Record<string, unknown>;
      const author = String(comment.author ?? '');
      const body = String(comment.body ?? '');
      const createdAt = String(comment.createdAt ?? '');
      if (!author || !body) continue;
      messages.push({
        senderId: author,
        role: 'user',
        content: this.sanitizer.sanitize(body),
        timestamp: this.parseTimestampMs(createdAt),
      });
    }

    // 再写入系统请求与 assistant 评审结果，确保 EverOS 用户侧流水线能提取 episode
    messages.push(
      {
        senderId: ctx.userId,
        role: 'user',
        content: `请求评审 MR !${mrIid}: ${title}`,
      },
      {
        senderId: ctx.agentId,
        role: 'assistant',
        content: reviewContent,
      }
    );

    await everosMemoryAddMessages(this.everosUrl, ctx, messages);

    // flush 会触发 LLM 边界检测与流水线，耗时较长；放到后台执行，避免 MCP 请求超时
    this.flushSession(ctx).catch((err) => {
      logger.error({ err, sessionId: ctx.sessionId }, 'record_review 后台 flush 失败');
    });
  }

  private parseTimestampMs(iso: string): number | undefined {
    const ts = Date.parse(iso);
    return Number.isNaN(ts) ? undefined : ts;
  }

  private async flushSession(ctx: MemoryContext): Promise<void> {
    await everosMemoryFlush(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
    });
  }

  private formatFindingsForMemory(findings: unknown[]): string {
    const items = findings
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => {
        const severity = String(f.severity ?? 'LOW');
        const file = String(f.file ?? 'unknown');
        const line = Number(f.line ?? 0);
        const message = String(f.message ?? '');
        return `- [${severity}] ${file}:${line} ${message}`;
      });
    return items.join('\n') || '无详细问题描述';
  }

  private async handleRecordProjectKnowledge(ctx: MemoryContext, items: ProjectKnowledgeItem[]): Promise<void> {
    if (items.length === 0) return;
    const sanitized = items.map((item) => ({
      ...item,
      content: this.sanitizer.sanitize(item.content),
    }));
    const content = `整理项目知识：\n${JSON.stringify(sanitized, null, 2)}`;
    await everosMemoryAdd(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      senderId: ctx.agentId,
      role: 'assistant',
      content,
    });
  }

  private async handleRecordFixAttempt(args: { context: MemoryContext } & Record<string, unknown>): Promise<void> {
    const ctx = args.context;
    const content = `Maintainer 在 MR !${String(args.mrIid ?? 0)} 尝试修复 ${String(args.file ?? '')}:${String(args.line ?? 0)}，结果=${args.success === true ? '成功' : '失败'}，理由=${String(args.reason ?? '')}`;
    await everosMemoryAdd(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      senderId: ctx.agentId,
      role: 'assistant',
      content,
    });
  }

  private async handleRecordInteraction(args: { context: MemoryContext } & Record<string, unknown>): Promise<void> {
    const ctx = args.context;
    const discussionId = String(args.discussionId ?? '');
    const userId = sanitizeEverOSId(String(args.userId ?? ''));
    const decision = String(args.decision ?? '');
    const outcome = String(args.outcome ?? '');
    const sessionId = `interaction-${discussionId}`;

    // Agent track：记录 Maintainer 视角的交互
    await everosMemoryAdd(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId,
      senderId: ctx.agentId,
      role: 'assistant',
      content: `与 ${userId} 的 discussion ${discussionId} 交互：决策=${decision}，结果=${outcome}`,
    });

    // User track：记录用户视角的交互
    await everosMemoryAdd(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId,
      senderId: userId,
      role: 'user',
      content: `在 discussion ${discussionId} 中，Maintainer 决策=${decision}，结果=${outcome}`,
    });
  }

  private async handleRecallForReview(args: { context: MemoryContext; query: string }): Promise<EverOSSearchItem[]> {
    const ctx = args.context;
    const result = await everosMemorySearch(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      owner: { kind: 'agent', agentId: 'reviewer' },
      query: args.query,
      topK: 5,
    });
    return result.items;
  }

  private async handleRecallForMaintenance(args: { context: MemoryContext; query: string }): Promise<EverOSSearchItem[]> {
    const ctx = args.context;
    const result = await everosMemorySearch(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      owner: { kind: 'agent', agentId: 'maintainer' },
      query: args.query,
      topK: 5,
    });
    return result.items;
  }

  private async handleRecallProjectKnowledge(args: { context: MemoryContext; query: string }): Promise<EverOSSearchItem[]> {
    const ctx = args.context;
    const result = await everosMemorySearch(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      owner: { kind: 'agent', agentId: 'archiver' },
      query: args.query,
      topK: 5,
    });
    return result.items;
  }

  private async handleMemoryDelete(args: { context: MemoryContext } & Record<string, unknown>): Promise<void> {
    const ctx = args.context;
    const sessionId = String(args.sessionId ?? '');
    logger.info({ appId: ctx.appId, projectId: ctx.projectId, sessionId }, '标记记忆删除');
    // EverOS 当前未暴露 memory 物理删除 API，tool 层仅记录 tombstone，后续由 Reflection/GC 处理
  }

  private async handleRecallUserPreferences(args: {
    context: MemoryContext;
    userId: string;
    query: string;
  }): Promise<EverOSSearchItem[]> {
    const ctx = args.context;
    const result = await everosMemorySearch(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      owner: { kind: 'user', userId: args.userId },
      query: args.query,
      topK: 5,
    });
    return result.items;
  }
}
