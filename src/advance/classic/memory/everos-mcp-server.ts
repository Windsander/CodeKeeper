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

  private errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: `error: ${message}` } as TextContent], isError: true };
  }

  private async handleRecordReview(args: { context: MemoryContext } & Record<string, unknown>): Promise<void> {
    const ctx = args.context;
    const summary = this.sanitizer.sanitize(String(args.summary ?? ''));
    const content = `Reviewer 评审 MR !${String(args.mrIid ?? 0)}: ${String(args.title ?? '')}。发现 ${String(args.findingsCount ?? 0)} 个问题。总结：${summary}`;
    await this.everosMemoryAdd(ctx, content);
  }

  private async handleRecordProjectKnowledge(ctx: MemoryContext, items: ProjectKnowledgeItem[]): Promise<void> {
    if (items.length === 0) return;
    const sanitized = items.map((item) => ({
      ...item,
      content: this.sanitizer.sanitize(item.content),
    }));
    const content = `整理项目知识：\n${JSON.stringify(sanitized, null, 2)}`;
    await this.everosMemoryAdd(ctx, content);
  }

  private async everosMemoryAdd(ctx: MemoryContext, content: string): Promise<void> {
    const body = {
      app_id: sanitizeEverOSId(ctx.appId),
      project_id: sanitizeEverOSId(ctx.projectId),
      session_id: sanitizeEverOSId(ctx.sessionId),
      messages: [
        {
          sender_id: sanitizeEverOSId(ctx.agentId),
          role: 'assistant',
          timestamp: Date.now(),
          content,
        },
      ],
    };

    const res = await fetch(`${this.everosUrl}/api/v1/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`EverOS memory/add 失败: ${res.status} ${await res.text()}`);
    }
  }
}
