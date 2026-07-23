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
import type {
  MemoryContext,
  MemoryFindingCase,
  MemoryReviewComment,
  ProjectKnowledgeItem,
} from './types.js';
import { sanitizeEverOSId } from './types.js';
import {
  everosMemoryAddMessages,
  everosMemorySearch,
  everosMemoryFlush,
  type EverOSAddMessage,
  type EverOSSearchItem,
} from './everos-api.js';
import { isAgentAuthoredNote } from '../runners/shared/review-utils.js';
import type { IMemoryWriteQueue } from './memory-write-queue.js';

/** 单条评论写入记忆时的最大字符数，避免过大 payload 拖慢 EverOS 流水线 */
const DEFAULT_MAX_COMMENT_CONTENT_LENGTH = 2000;
/** 单次 record_review 最多写入多少条远端评论，降低 EverOS 提取负载 */
const DEFAULT_MAX_COMMENT_COUNT = 50;

export interface BuildReviewMemoryInput {
  ctx: MemoryContext;
  mrIid: string;
  title: string;
  findingsCount: number;
  summary: string;
  findings: unknown[];
  comments: MemoryReviewComment[];
  mrAuthor?: string;
  maxCommentContentLength?: number;
  maxCommentCount?: number;
}

export interface BuildReviewMemoryResult {
  messages: EverOSAddMessage[];
  owners: Array<{ ownerId: string; ownerType: 'user' | 'agent'; displayName?: string }>;
}

/**
 * 将 findings 格式化为记忆文本
 */
export function formatFindingsForMemory(findings: unknown[]): string {
  const items = findings
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map(f => {
      const severity = String(f.severity ?? 'LOW');
      const file = String(f.file ?? 'unknown');
      const line = Number(f.line ?? 0);
      const message = String(f.message ?? '');
      return `- [${severity}] ${file}:${line} ${message}`;
    });
  return items.join('\n') || '无详细问题描述';
}

/**
 * 把单条 finding case 格式化为带结构化标记的文本，便于按 key 召回。
 */
export function formatFindingCaseContent(c: MemoryFindingCase): string {
  const lines = [
    `[CASE:${c.key}]`,
    `MR: !${c.mrIid}`,
    `文件: ${c.file}`,
    `行号: ${c.line}`,
    `级别: ${c.severity}`,
  ];
  if (c.ruleId) lines.push(`规则: ${c.ruleId}`);
  lines.push(`问题: ${c.message}`);
  if (c.suggestion) lines.push(`建议: ${c.suggestion}`);
  lines.push(`状态: ${c.status}`);
  if (c.discussionId) lines.push(`讨论ID: ${c.discussionId}`);
  return lines.join('\n');
}

function parseTimestampMs(iso: string): number | undefined {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? undefined : ts;
}

/**
 * 构造 Reviewer 评审要写入 EverOS 的消息列表和 owner 注册表。
 *
 * 关键约定：
 * - 没有真实评论时，使用 MR 作者作为 user 锚点 sender，而不是 codekeeper-system，
 *   避免所有 review episode 都挂到 system 节点上。
 * - Agent 自己发的评论以 assistant 身份写入，人类评论以 user 身份写入。
 */
export function buildReviewMemoryMessages(input: BuildReviewMemoryInput): BuildReviewMemoryResult {
  const {
    ctx,
    mrIid,
    title,
    findingsCount,
    summary,
    findings,
    comments,
    mrAuthor,
    maxCommentContentLength = DEFAULT_MAX_COMMENT_CONTENT_LENGTH,
    maxCommentCount = DEFAULT_MAX_COMMENT_COUNT,
  } = input;

  const sanitizer = new SecretSanitizer();
  const findingsText = formatFindingsForMemory(findings);
  const reviewContent = `Reviewer 评审 MR !${mrIid}: ${title}。\n发现 ${findingsCount} 个问题。\n总结：${summary}\n\nFindings:\n${findingsText}`;

  const messages: EverOSAddMessage[] = [];
  const userOwners = new Map<string, string | undefined>();

  // 按时间排序，避免消息顺序混乱影响 EverOS 提取
  const sortedComments = [...comments]
    .sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    })
    .slice(0, maxCommentCount);

  // 远端评论：Agent 借 token 发的评论以 assistant 身份写入（与总结一致），
  // 人类/其他 bot 的评论以 user 身份写入。
  for (const comment of sortedComments) {
    const { author, body: rawBody, createdAt } = comment;
    if (!author || !rawBody) continue;
    const body =
      rawBody.length > maxCommentContentLength
        ? `${rawBody.slice(0, maxCommentContentLength)}…（已截断）`
        : rawBody;
    const sanitizedBody = sanitizer.sanitize(body);
    const isAgentNote = isAgentAuthoredNote(body);
    const senderId = isAgentNote ? ctx.agentId : sanitizeEverOSId(author);
    messages.push({
      senderId,
      role: isAgentNote ? 'assistant' : 'user',
      content: sanitizedBody,
      timestamp: parseTimestampMs(createdAt),
    });
    if (!isAgentNote) {
      userOwners.set(senderId, undefined);
    }
  }

  // 没有评论时追加 user 锚点，确保 assistant 前面有 user 消息。
  // 优先使用 MR 作者作为 sender，避免把 episode owner 变成 system。
  if (messages.length === 0) {
    const anchorSender = mrAuthor ? sanitizeEverOSId(mrAuthor) : ctx.userId;
    const anchorContent = mrAuthor
      ? `MR 作者 ${anchorSender} 提交/更新了 MR !${mrIid}: ${title}`
      : `对 MR !${mrIid}: ${title} 发起自动评审`;
    messages.push({
      senderId: anchorSender,
      role: 'user',
      content: anchorContent,
    });
    // 只有真实 MR 作者才注册为 user owner；system 锚点不注册
    if (mrAuthor) {
      userOwners.set(anchorSender, mrAuthor);
    }
  }

  // 最后写入 assistant 评审结果
  messages.push({
    senderId: ctx.agentId,
    role: 'assistant',
    content: reviewContent,
  });

  const owners: Array<{ ownerId: string; ownerType: 'user' | 'agent'; displayName?: string }> = [
    { ownerId: ctx.agentId, ownerType: 'agent', displayName: ctx.agentDisplayName },
  ];
  for (const [ownerId, displayName] of userOwners) {
    owners.push({ ownerId, ownerType: 'user', displayName });
  }

  return { messages, owners };
}

export interface EverOSMcpServerOptions {
  /** EverOS HTTP API URL */
  everosUrl: string;
  /** 监听端口；0 表示随机 */
  port?: number;
  /** 失败记忆写入队列；提供后，写入失败会自动落库重试 */
  queue?: IMemoryWriteQueue;
  /** 记忆写入产生新的 user/agent owner 时回调，用于更新项目 owner 注册表 */
  onMemoryOwners?: (
    projectId: string,
    owners: Array<{ ownerId: string; ownerType: 'user' | 'agent'; displayName?: string }>
  ) => void;
}

/**
 * 将 EverOS 能力包装为语义化 MCP Server
 */
export class EverOSMcpServer {
  private httpServer: HttpServer | null = null;
  private readonly everosUrl: string;
  private readonly port: number;
  private readonly queue?: IMemoryWriteQueue;
  private readonly onMemoryOwners?: (
    projectId: string,
    owners: Array<{ ownerId: string; ownerType: 'user' | 'agent'; displayName?: string }>
  ) => void;
  private readonly sanitizer = new SecretSanitizer();

  constructor(options: EverOSMcpServerOptions) {
    this.everosUrl = options.everosUrl;
    this.port = options.port ?? 0;
    this.queue = options.queue;
    this.onMemoryOwners = options.onMemoryOwners;
  }

  /**
   * 启动 HTTP SSE 服务
   *
   * 每个 SSE 连接创建独立的 MCP Server 实例，避免 SDK 的 "Already connected to a transport" 限制。
   */
  async start(): Promise<string> {
    return new Promise(resolve => {
      const transportMap = new Map<string, SSEServerTransport>();
      const serverMap = new Map<string, Server>();

      this.httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        if (url.pathname === '/sse') {
          const transport = new SSEServerTransport('/messages', res);
          const sessionId = transport.sessionId;
          transportMap.set(sessionId, transport);

          const server = new Server(
            { name: 'codekeeper-everos-mcp', version: '0.1.0' },
            { capabilities: { tools: {} } }
          );
          this.registerTools(server);
          serverMap.set(sessionId, server);

          res.on('close', async () => {
            transportMap.delete(sessionId);
            const s = serverMap.get(sessionId);
            if (s) {
              try {
                await s.close();
              } catch (err) {
                logger.warn({ err, sessionId }, '关闭 EverOS MCP server 会话失败');
              }
              serverMap.delete(sessionId);
            }
          });

          await server.connect(transport);
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
    return new Promise(resolve => {
      this.httpServer?.close(() => resolve());
    });
  }

  private registerTools(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
          name: 'record_finding_cases',
          description: 'Reviewer 把每条 finding 记录为可检索的 case',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              cases: {
                type: 'array',
                description: '要记录的 finding case 列表',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string' },
                    mrIid: { type: 'number' },
                    file: { type: 'string' },
                    line: { type: 'number' },
                    severity: { type: 'string' },
                    ruleId: { type: 'string' },
                    message: { type: 'string' },
                    suggestion: { type: 'string' },
                    status: { type: 'string', enum: ['open', 'resolved', 'reopen'] },
                    discussionId: { type: 'string' },
                  },
                  required: ['key', 'mrIid', 'file', 'line', 'severity', 'message', 'status'],
                },
              },
            },
            required: ['context', 'cases'],
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
          name: 'record_reflection',
          description: '记录 Maintainer 对某条 finding case 的修复反思',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              caseKey: { type: 'string' },
              reflection: { type: 'string' },
              outcome: { type: 'string', enum: ['success', 'failure'] },
            },
            required: ['context', 'caseKey', 'reflection', 'outcome'],
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
          name: 'recall_finding_case',
          description: '按 case key 召回历史 finding case 详情',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
              key: {
                type: 'string',
                description: 'case key，例如 case:proj:mr-1:file:line:ruleId',
              },
            },
            required: ['context', 'key'],
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
        {
          name: 'flush_session',
          description: '强制刷新当前 session 的记忆缓冲区，使 add-only 的写入立即进入提取流水线',
          inputSchema: {
            type: 'object',
            properties: {
              context: { type: 'object' },
            },
            required: ['context'],
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;
      logger.info({ tool: name }, '调用 MCP tool');

      try {
        if (name === 'record_review') {
          await this.handleRecordReview(
            args as { context: MemoryContext } & Record<string, unknown>
          );
          return this.okResult();
        }
        if (name === 'record_finding_cases') {
          await this.handleRecordFindingCases(
            args as { context: MemoryContext } & Record<string, unknown>
          );
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
          await this.handleRecordFixAttempt(
            args as { context: MemoryContext } & Record<string, unknown>
          );
          return this.okResult();
        }
        if (name === 'record_interaction') {
          await this.handleRecordInteraction(
            args as { context: MemoryContext } & Record<string, unknown>
          );
          return this.okResult();
        }
        if (name === 'record_reflection') {
          await this.handleRecordReflection(
            args as { context: MemoryContext } & Record<string, unknown>
          );
          return this.okResult();
        }
        if (name === 'recall_for_review') {
          return this.recallResult(
            await this.handleRecallForReview(args as { context: MemoryContext; query: string })
          );
        }
        if (name === 'recall_finding_case') {
          return this.recallResult(
            await this.handleRecallFindingCase(args as { context: MemoryContext; key: string })
          );
        }
        if (name === 'recall_for_maintenance') {
          return this.recallResult(
            await this.handleRecallForMaintenance(args as { context: MemoryContext; query: string })
          );
        }
        if (name === 'recall_project_knowledge') {
          return this.recallResult(
            await this.handleRecallProjectKnowledge(
              args as { context: MemoryContext; query: string }
            )
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
          await this.handleMemoryDelete(
            args as { context: MemoryContext } & Record<string, unknown>
          );
          return this.okResult();
        }
        if (name === 'flush_session') {
          await this.handleFlushSession((args as { context: MemoryContext }).context);
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
      .map(item => (item.source ? `${item.source}\n${item.content}` : item.content));
    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) } as TextContent],
    };
  }

  private errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: `error: ${message}` } as TextContent], isError: true };
  }

  private async handleRecordReview(
    args: { context: MemoryContext } & Record<string, unknown>
  ): Promise<void> {
    const ctx = args.context;
    const summary = this.sanitizer.sanitize(String(args.summary ?? ''));
    const findings = Array.isArray(args.findings) ? args.findings : [];
    const comments = (Array.isArray(args.comments) ? args.comments : []) as MemoryReviewComment[];
    const mrIid = String(args.mrIid ?? 0);
    const title = String(args.title ?? '');
    const mrAuthor = String(args.mrAuthor ?? '');

    const { messages, owners } = buildReviewMemoryMessages({
      ctx,
      mrIid,
      title,
      findingsCount: Number(args.findingsCount ?? 0),
      summary,
      findings,
      comments,
      mrAuthor,
    });

    this.onMemoryOwners?.(ctx.projectId, owners);

    this.persistReview(ctx, messages).catch(err => {
      logger.error({ err, sessionId: ctx.sessionId }, 'record_review 后台记忆写入失败');
      this.queue?.enqueue(ctx, 'add_messages', messages);
    });
  }

  private async handleRecordFindingCases(
    args: { context: MemoryContext } & Record<string, unknown>
  ): Promise<void> {
    const ctx = args.context;
    const cases = (Array.isArray(args.cases) ? args.cases : []) as MemoryFindingCase[];
    if (cases.length === 0) return;

    const caseCtx: MemoryContext = {
      ...ctx,
      agentId: 'reviewer-case',
      agentDisplayName: 'Reviewer Finding Case',
      sessionId: `finding-cases-${ctx.projectId}`,
    };
    this.registerAgentOwner(caseCtx);
    const messages: EverOSAddMessage[] = cases.map(c => ({
      senderId: 'reviewer-case',
      role: 'assistant',
      content: formatFindingCaseContent(c),
    }));

    this.persistAndFlush(caseCtx, messages).catch(err => {
      logger.error({ err, sessionId: caseCtx.sessionId }, 'record_finding_cases 后台记忆写入失败');
    });
  }

  private async persistReview(ctx: MemoryContext, messages: EverOSAddMessage[]): Promise<void> {
    const start = Date.now();
    const senderSet = new Set(messages.map(m => `${m.role}:${m.senderId}`));
    logger.info(
      { sessionId: ctx.sessionId, messageCount: messages.length, senders: [...senderSet] },
      'record_review 批量写入 EverOS'
    );
    await everosMemoryAddMessages(this.everosUrl, ctx, messages);
    try {
      await this.flushSession(ctx);
    } catch (flushErr) {
      logger.error(
        { err: flushErr, sessionId: ctx.sessionId },
        'record_review flush 失败，已入队重试'
      );
      this.queue?.enqueue(ctx, 'flush');
    }
    logger.info(
      { sessionId: ctx.sessionId, durationMs: Date.now() - start },
      'record_review 后台记忆写入完成'
    );
  }

  /**
   * 批量写入并立即 flush，用于 finding case 这类需要被立即召回的记忆。
   */
  private async persistAndFlush(ctx: MemoryContext, messages: EverOSAddMessage[]): Promise<void> {
    const start = Date.now();
    try {
      await everosMemoryAddMessages(this.everosUrl, ctx, messages);
    } catch (error) {
      this.queue?.enqueue(ctx, 'add_messages', messages);
      throw error;
    }
    try {
      await this.flushSession(ctx);
    } catch (error) {
      this.queue?.enqueue(ctx, 'flush');
      throw error;
    }
    logger.info(
      { sessionId: ctx.sessionId, messageCount: messages.length, durationMs: Date.now() - start },
      'finding case 批量写入并 flush 完成'
    );
  }

  private async flushSession(ctx: MemoryContext): Promise<void> {
    await everosMemoryFlush(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
    });
  }

  private async handleRecordProjectKnowledge(
    ctx: MemoryContext,
    items: ProjectKnowledgeItem[]
  ): Promise<void> {
    if (items.length === 0) return;
    this.registerAgentOwner(ctx);
    const sanitized = items.map(item => ({
      ...item,
      content: this.sanitizer.sanitize(item.content),
    }));
    const content = `整理项目知识：\n${JSON.stringify(sanitized, null, 2)}`;

    await this.persistSingleMessage(ctx, ctx.agentId, 'assistant', content, true);
  }

  private async handleRecordFixAttempt(
    args: { context: MemoryContext } & Record<string, unknown>
  ): Promise<void> {
    const ctx = args.context;
    this.registerAgentOwner(ctx);
    const content = `Maintainer 在 MR !${String(args.mrIid ?? 0)} 尝试修复 ${String(args.file ?? '')}:${String(args.line ?? 0)}，结果=${args.success === true ? '成功' : '失败'}，理由=${String(args.reason ?? '')}`;

    try {
      await this.persistSingleMessage(ctx, ctx.agentId, 'assistant', content);
    } catch (err) {
      logger.error({ err, sessionId: ctx.sessionId }, 'record_fix_attempt 后台记忆写入失败');
    }
  }

  private async handleRecordInteraction(
    args: { context: MemoryContext } & Record<string, unknown>
  ): Promise<void> {
    const ctx = args.context;
    this.registerAgentOwner(ctx);
    const discussionId = String(args.discussionId ?? '');
    const userId = sanitizeEverOSId(String(args.userId ?? ''));
    const decision = String(args.decision ?? '');
    const outcome = String(args.outcome ?? '');
    const sessionId = `interaction-${discussionId}`;
    const interactionCtx: MemoryContext = { ...ctx, sessionId };
    const messages: EverOSAddMessage[] = [
      {
        senderId: ctx.agentId,
        role: 'assistant',
        content: `与 ${userId} 的 discussion ${discussionId} 交互：决策=${decision}，结果=${outcome}`,
      },
      {
        senderId: userId,
        role: 'user',
        content: `在 discussion ${discussionId} 中，Maintainer 决策=${decision}，结果=${outcome}`,
      },
    ];

    try {
      await this.persistMessages(interactionCtx, messages);
    } catch (err) {
      logger.error({ err, sessionId }, 'record_interaction 后台记忆写入失败，已入队重试');
    }
  }

  private async handleRecordReflection(
    args: { context: MemoryContext } & Record<string, unknown>
  ): Promise<void> {
    const ctx = args.context;
    this.registerAgentOwner(ctx);
    const caseKey = String(args.caseKey ?? '');
    const reflection = String(args.reflection ?? '');
    const outcome = String(args.outcome ?? '');
    const content = `[CASE:${caseKey}]\n反思: ${reflection}\n结果: ${outcome}\n时间: ${new Date().toISOString()}`;

    try {
      await this.persistSingleMessage(ctx, ctx.agentId, 'assistant', content);
    } catch (err) {
      logger.error({ err, sessionId: ctx.sessionId }, 'record_reflection 后台记忆写入失败');
    }
  }

  private async persistMessages(ctx: MemoryContext, messages: EverOSAddMessage[]): Promise<void> {
    const start = Date.now();
    try {
      await everosMemoryAddMessages(this.everosUrl, ctx, messages);
    } catch (err) {
      this.queue?.enqueue(ctx, 'add_messages', messages);
      throw err;
    }
    try {
      await this.flushSession(ctx);
    } catch (err) {
      this.queue?.enqueue(ctx, 'flush');
      throw err;
    }
    logger.info(
      { sessionId: ctx.sessionId, messageCount: messages.length, durationMs: Date.now() - start },
      '多条记忆后台写入完成'
    );
  }

  private async persistSingleMessage(
    ctx: MemoryContext,
    senderId: string,
    role: 'user' | 'assistant' | 'tool',
    content: string,
    acceptQueued = false
  ): Promise<void> {
    const start = Date.now();
    const messages: EverOSAddMessage[] = [
      {
        senderId: sanitizeEverOSId(senderId),
        role: 'user',
        content: '系统记录以下维护记忆，请将其纳入项目记忆。',
      },
      { senderId, role, content },
    ];
    try {
      await everosMemoryAddMessages(this.everosUrl, ctx, messages);
    } catch (err) {
      if (this.queue) {
        this.queue.enqueue(ctx, 'add_messages', messages);
        logger.warn({ err, sessionId: ctx.sessionId }, '单条记忆写入失败，已由队列接管');
        if (acceptQueued) return;
      }
      throw err;
    }
    try {
      await this.flushSession(ctx);
    } catch (err) {
      if (this.queue) {
        this.queue.enqueue(ctx, 'flush');
        logger.warn({ err, sessionId: ctx.sessionId }, '单条记忆 flush 失败，已由队列接管');
        if (acceptQueued) return;
      }
      throw err;
    }
    logger.info(
      { sessionId: ctx.sessionId, durationMs: Date.now() - start },
      '单条记忆后台写入完成'
    );
  }

  private registerAgentOwner(ctx: MemoryContext): void {
    this.onMemoryOwners?.(ctx.projectId, [
      {
        ownerId: sanitizeEverOSId(ctx.agentId),
        ownerType: 'agent',
        displayName: ctx.agentDisplayName,
      },
    ]);
  }

  private async handleRecallForReview(args: {
    context: MemoryContext;
    query: string;
  }): Promise<EverOSSearchItem[]> {
    const ctx = args.context;
    const ownerResult = await everosMemorySearch(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      owner: { kind: 'agent', agentId: ctx.agentId },
      query: args.query,
      topK: 5,
    });

    return ownerResult.items;
  }

  private async handleRecallFindingCase(args: {
    context: MemoryContext;
    key: string;
  }): Promise<EverOSSearchItem[]> {
    const ctx = args.context;
    const result = await everosMemorySearch(this.everosUrl, {
      appId: ctx.appId,
      projectId: ctx.projectId,
      owner: { kind: 'agent', agentId: 'reviewer-case' },
      query: args.key,
      topK: 5,
    });

    return result.items;
  }

  private async handleRecallForMaintenance(args: {
    context: MemoryContext;
    query: string;
  }): Promise<EverOSSearchItem[]> {
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

  private async handleRecallProjectKnowledge(args: {
    context: MemoryContext;
    query: string;
  }): Promise<EverOSSearchItem[]> {
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

  private async handleMemoryDelete(
    args: { context: MemoryContext } & Record<string, unknown>
  ): Promise<void> {
    const ctx = args.context;
    const sessionId = String(args.sessionId ?? '');
    logger.info({ appId: ctx.appId, projectId: ctx.projectId, sessionId }, '标记记忆删除');
    // EverOS 当前未暴露 memory 物理删除 API，tool 层仅记录 tombstone，后续由 Reflection/GC 处理
  }

  private async handleFlushSession(ctx: MemoryContext): Promise<void> {
    logger.info(
      { appId: ctx.appId, projectId: ctx.projectId, sessionId: ctx.sessionId },
      'flush session'
    );
    try {
      await this.flushSession(ctx);
    } catch (err) {
      logger.error({ err, sessionId: ctx.sessionId }, 'flush_session 失败，已入队重试');
      this.queue?.enqueue(ctx, 'flush');
      throw err;
    }
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
