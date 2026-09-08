/**
 * CodeKeeper MCP 门面：把管线与智库能力暴露给外部 Agent（方向 B）。
 *
 * 外部 Agent（OpenCode、Claude Code、自研工具等）作为 MCP client 连接后，
 * 可以查询管线运行状态、手动触发角色执行、召回项目知识。
 *
 * 安全模型：
 * - 仅监听 127.0.0.1；
 * - 启动时生成随机 token 编入门面 URL（http://127.0.0.1:port/sse?token=...），
 *   未带正确 token 的连接一律 401；URL 经 daemon 状态展示给本机用户。
 * - pipeline_submit 具有真实世界写副作用（评审评论/修复/合并），
 *   绑定本机 + token 即"信任本机持有者"模型，详见 SECURITY.md。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../core/logger.js';
import { everosMemorySearchProject } from '../classic/memory/everos-api.js';
import type { PipelineScheduler } from '../pipeline/pipeline-scheduler.js';
import { ROLES, type Role } from '../types.js';

export interface McpFacadeOptions {
  scheduler: PipelineScheduler;
  /** EverOS HTTP 服务地址；未就绪时知识召回返回明确错误 */
  getEverosUrl: () => string | null;
  port?: number;
}

const APP_ID = 'codekeeper-advance';

export class McpFacadeServer {
  private httpServer: http.Server | null = null;
  /** 活动 SSE 会话：stop 时主动关闭，避免 daemon 无法退出 */
  private readonly sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  private readonly token = randomUUID();

  constructor(private readonly options: McpFacadeOptions) {}

  /** 启动并返回带 token 的门面地址 */
  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handleRequest(req, res));
      server.on('error', reject);
      this.httpServer = server;

      server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        // 直接返回可用的 SSE 端点（含 token），复制即可接入
        resolve(`http://127.0.0.1:${port}/sse?token=${this.token}`);
      });
    });
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        await session.server.close();
        await session.transport.close();
      } catch (error) {
        logger.warn({ err: error }, '关闭 MCP 门面会话失败');
      }
    }
    this.sessions.clear();
    await new Promise<void>(resolve => {
      this.httpServer?.closeAllConnections();
      this.httpServer?.close(() => resolve());
    });
    this.httpServer = null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.searchParams.get('token') !== this.token) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    if (url.pathname === '/sse') {
      const transport = new SSEServerTransport(`/messages?token=${this.token}`, res);
      const sessionId = transport.sessionId;
      const server = new Server(
        { name: 'codekeeper-facade-mcp', version: '0.1.0' },
        { capabilities: { tools: {} } }
      );
      this.registerTools(server);
      this.sessions.set(sessionId, { transport, server });

      res.on('close', async () => {
        this.sessions.delete(sessionId);
        try {
          await server.close();
        } catch (error) {
          logger.warn({ err: error, sessionId }, '关闭 MCP 门面会话失败');
        }
      });

      await server.connect(transport);
      return;
    }

    if (url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const session = this.sessions.get(sessionId);
      if (!session) {
        res.writeHead(404);
        res.end('session not found');
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }

  private registerTools(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'pipeline_list_runs',
          description: '查询项目管线的最近运行记录（含节点级状态）',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['projectId'],
          },
        },
        {
          name: 'pipeline_submit',
          description: '手动触发项目某个角色节点立即执行一轮（异步派发，不等待执行完成）',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              role: { type: 'string', enum: [...ROLES] },
            },
            required: ['projectId', 'role'],
          },
        },
        {
          name: 'knowledge_recall',
          description: '召回项目长期记忆中的相关知识（EverOS）',
          inputSchema: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              query: { type: 'string' },
              topK: { type: 'number' },
            },
            required: ['projectId', 'query'],
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async request => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        switch (request.params.name) {
          case 'pipeline_list_runs':
            return jsonResult(
              this.options.scheduler.listPipelineRuns(
                String(args.projectId),
                typeof args.limit === 'number' ? args.limit : 10
              )
            );
          case 'pipeline_submit': {
            const role = String(args.role);
            if (!ROLES.includes(role as Role)) {
              return jsonResult({ error: `未知角色: ${role}` });
            }
            // 异步派发：角色执行可达分钟级，不阻塞 MCP client
            void this.options.scheduler
              .runProjectRoleNow(String(args.projectId), role as Role)
              .catch(error => {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[MCP门面] pipeline_submit 执行失败: ${message}`);
              });
            return jsonResult({ submitted: true });
          }
          case 'knowledge_recall': {
            const everosUrl = this.options.getEverosUrl();
            if (!everosUrl) {
              return jsonResult({ error: 'EverOS 未就绪，知识召回不可用' });
            }
            const result = await everosMemorySearchProject(everosUrl, {
              appId: APP_ID,
              projectId: String(args.projectId),
              query: String(args.query),
              topK: typeof args.topK === 'number' ? args.topK : 5,
            });
            return jsonResult(result);
          }
          default:
            return jsonResult({ error: `未知工具: ${request.params.name}` });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ error: message });
      }
    });
  }
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
