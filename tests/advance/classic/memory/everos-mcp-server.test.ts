// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  EverOSMcpServer,
  buildReviewMemoryMessages,
} from '../../../../src/advance/classic/memory/everos-mcp-server.js';
import type { MemoryContext, MemoryReviewComment } from '../../../../src/advance/classic/memory/types.js';
import { everosMemoryAddMessages, everosMemoryFlush } from '../../../../src/advance/classic/memory/everos-api.js';
import type { IMemoryWriteQueue } from '../../../../src/advance/classic/memory/memory-write-queue.js';

vi.mock('../../../../src/advance/classic/memory/everos-api.js', () => ({
  everosMemoryAddMessages: vi.fn(),
  everosMemoryAdd: vi.fn(),
  everosMemoryFlush: vi.fn(),
  everosMemorySearch: vi.fn(),
}));

function makeCtx(overrides?: Partial<MemoryContext>): MemoryContext {
  return {
    appId: 'codekeeper-advance',
    projectId: 'proj-1',
    agentId: 'reviewer-agent-1',
    agentDisplayName: 'Reviewer 测试 Agent',
    userId: 'codekeeper-system',
    sessionId: 'reviewer-proj-1-mr-1',
    ...overrides,
  };
}

describe('EverOSMcpServer', () => {
  let server: EverOSMcpServer;
  let url: string;

  beforeAll(async () => {
    server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999' });
    url = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('启动后返回本地 URL', () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('EverOSMcpServer 失败入队', () => {
  async function connect(server: EverOSMcpServer): Promise<{ client: Client; transport: SSEClientTransport; url: string }> {
    const url = await server.start();
    const client = new Client({ name: 'test', version: '0.1.0' });
    const transport = new SSEClientTransport(new URL('/sse', url));
    await client.connect(transport);
    return { client, transport, url };
  }

  it('record_review 写入失败时把消息加入重试队列', async () => {
    vi.mocked(everosMemoryAddMessages).mockRejectedValue(new Error('429 boom'));
    vi.mocked(everosMemoryFlush).mockResolvedValue(undefined);

    const queue: IMemoryWriteQueue = {
      enqueue: vi.fn(),
      listReady: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      markFailed: vi.fn(),
    };
    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999', queue });
    const { client, transport } = await connect(server);

    const ctx = makeCtx({ sessionId: 'sess-fail' });
    await client.callTool({
      name: 'record_review',
      arguments: {
        context: ctx,
        mrIid: 1,
        title: 'test',
        findingsCount: 0,
        summary: 'summary',
        findings: [],
        comments: [],
      },
    });

    // 后台写入是异步的，等待一小段时间让 catch 入队
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(ctx, 'add_messages', expect.any(Array));

    await transport.close();
    await server.stop();
  });

  it('record_review add 成功但 flush 失败时入队 flush 任务', async () => {
    vi.mocked(everosMemoryAddMessages).mockResolvedValue(undefined);
    vi.mocked(everosMemoryFlush).mockRejectedValue(new Error('flush boom'));

    const queue: IMemoryWriteQueue = {
      enqueue: vi.fn(),
      listReady: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      markFailed: vi.fn(),
    };
    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999', queue });
    const { client, transport } = await connect(server);

    const ctx = makeCtx({ sessionId: 'sess-flush-fail' });
    await client.callTool({
      name: 'record_review',
      arguments: {
        context: ctx,
        mrIid: 2,
        title: 'test',
        findingsCount: 0,
        summary: 'summary',
        findings: [],
        comments: [],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(ctx, 'flush');

    await transport.close();
    await server.stop();
  });
});

describe('buildReviewMemoryMessages', () => {
  it('没有评论且提供 MR 作者时，锚点使用 MR 作者而不是 system，并不注册 system owner', () => {
    const ctx = makeCtx();
    const result = buildReviewMemoryMessages({
      ctx,
      mrIid: '1',
      title: 'feat: 示例 MR',
      findingsCount: 0,
      summary: '无问题',
      findings: [],
      comments: [],
      mrAuthor: 'alice',
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].senderId).toBe('alice');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('MR 作者 alice');
    expect(result.messages[1].senderId).toBe(ctx.agentId);
    expect(result.messages[1].role).toBe('assistant');

    const ownerIds = result.owners.map((o) => o.ownerId);
    expect(ownerIds).toContain(ctx.agentId);
    expect(ownerIds).toContain('alice');
    expect(ownerIds).not.toContain('codekeeper-system');
  });

  it('没有评论且未提供 MR 作者时，使用 system 锚点但不注册 system owner', () => {
    const ctx = makeCtx();
    const result = buildReviewMemoryMessages({
      ctx,
      mrIid: '2',
      title: 'feat: 示例 MR',
      findingsCount: 0,
      summary: '无问题',
      findings: [],
      comments: [],
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].senderId).toBe('codekeeper-system');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('发起自动评审');

    const ownerIds = result.owners.map((o) => o.ownerId);
    expect(ownerIds).toContain(ctx.agentId);
    expect(ownerIds).not.toContain('codekeeper-system');
  });

  it('有人类评论时，不插入锚点，人类以 user 身份写入并注册 owner', () => {
    const ctx = makeCtx();
    const comments: MemoryReviewComment[] = [
      { author: 'bob', body: '这里为什么这么写？', createdAt: '2026-07-03T06:00:00Z' },
    ];
    const result = buildReviewMemoryMessages({
      ctx,
      mrIid: '3',
      title: 'feat: 示例 MR',
      findingsCount: 1,
      summary: '有一个问题',
      findings: [{ severity: 'LOW', file: 'a.ts', line: 1, message: '问题', suggestion: '建议' }],
      comments,
      mrAuthor: 'alice',
    });

    // 人类评论 + assistant 总结 = 2 条
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].senderId).toBe('bob');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');

    const ownerIds = result.owners.map((o) => o.ownerId);
    expect(ownerIds).toContain('bob');
    expect(ownerIds).not.toContain('codekeeper-system');
  });

  it('Agent 自己发的评论以 assistant 身份写入，不重复注册 owner', () => {
    const ctx = makeCtx();
    const agentBody =
      '这是一个回复\n\n---\n*生成于 2026/07/03 06:00:00 · CodeKeeper Advance MR 评审 Agent · Reviewer 测试 Agent*';
    const comments: MemoryReviewComment[] = [
      { author: 'alice', body: agentBody, createdAt: '2026-07-03T06:00:00Z' },
    ];
    const result = buildReviewMemoryMessages({
      ctx,
      mrIid: '4',
      title: 'feat: 示例 MR',
      findingsCount: 1,
      summary: '有一个问题',
      findings: [{ severity: 'LOW', file: 'a.ts', line: 1, message: '问题', suggestion: '建议' }],
      comments,
      mrAuthor: 'alice',
    });

    expect(result.messages[0].senderId).toBe(ctx.agentId);
    expect(result.messages[0].role).toBe('assistant');

    const userOwners = result.owners.filter((o) => o.ownerType === 'user');
    expect(userOwners).toHaveLength(0);
  });
});
