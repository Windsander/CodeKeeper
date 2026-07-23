// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  EverOSMcpServer,
  buildReviewMemoryMessages,
  formatFindingCaseContent,
} from '../../../../src/advance/classic/memory/everos-mcp-server.js';
import type {
  MemoryContext,
  MemoryReviewComment,
} from '../../../../src/advance/classic/memory/types.js';
import {
  everosMemoryAdd,
  everosMemoryAddMessages,
  everosMemoryFlush,
} from '../../../../src/advance/classic/memory/everos-api.js';
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
  async function connect(
    server: EverOSMcpServer
  ): Promise<{ client: Client; transport: SSEClientTransport; url: string }> {
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
    await new Promise(resolve => setTimeout(resolve, 50));

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

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(ctx, 'flush');

    await transport.close();
    await server.stop();
  });

  it('record_project_knowledge 写入失败且队列接管成功时返回成功', async () => {
    vi.mocked(everosMemoryAddMessages).mockReset().mockRejectedValue(new Error('add boom'));
    vi.mocked(everosMemoryFlush).mockReset().mockResolvedValue(undefined);
    const queue: IMemoryWriteQueue = {
      enqueue: vi.fn(),
      listReady: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      markFailed: vi.fn(),
    };
    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999', queue });
    const { client, transport } = await connect(server);
    const ctx = makeCtx({ agentId: 'archiver', sessionId: 'archiver-proj-1' });

    const result = await client.callTool({
      name: 'record_project_knowledge',
      arguments: {
        context: ctx,
        items: [
          {
            id: 'knowledge-queue-success',
            category: 'architecture',
            sourceFiles: ['virtual/module-a.ts'],
            content: '可由队列补偿的项目知识',
            confidence: 'high',
            createdAt: '2026-07-22T00:00:00.000Z',
          },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith(ctx, 'add_messages', expect.any(Array));

    await transport.close();
    await server.stop();
  });

  it('record_project_knowledge 写入与入队都失败时返回失败', async () => {
    vi.mocked(everosMemoryAddMessages).mockReset().mockRejectedValue(new Error('add boom'));
    vi.mocked(everosMemoryFlush).mockReset().mockResolvedValue(undefined);
    const queue: IMemoryWriteQueue = {
      enqueue: vi.fn(() => {
        throw new Error('queue boom');
      }),
      listReady: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      markFailed: vi.fn(),
    };
    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999', queue });
    const { client, transport } = await connect(server);
    const ctx = makeCtx({ agentId: 'archiver', sessionId: 'archiver-proj-1' });

    const result = await client.callTool({
      name: 'record_project_knowledge',
      arguments: {
        context: ctx,
        items: [
          {
            id: 'knowledge-queue-failure',
            category: 'architecture',
            sourceFiles: ['virtual/module-a.ts'],
            content: '无法持久化的项目知识',
            confidence: 'high',
            createdAt: '2026-07-22T00:00:00.000Z',
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('queue boom') }),
    ]);

    await transport.close();
    await server.stop();
  });

  it('record_finding_cases add 成功但 flush 失败时只入队 flush', async () => {
    vi.mocked(everosMemoryAddMessages).mockReset().mockResolvedValue(undefined);
    vi.mocked(everosMemoryFlush).mockReset().mockRejectedValue(new Error('flush boom'));
    const queue: IMemoryWriteQueue = {
      enqueue: vi.fn(),
      listReady: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      markFailed: vi.fn(),
    };
    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999', queue });
    const { client, transport } = await connect(server);
    const ctx = makeCtx();

    await client.callTool({
      name: 'record_finding_cases',
      arguments: {
        context: ctx,
        cases: [
          {
            key: 'case:proj-1:mr-1:virtual_module-a_ts:18:rule-example',
            mrIid: 1,
            file: 'virtual/module-a.ts',
            line: 18,
            severity: 'LOW',
            ruleId: 'rule-example',
            message: '示例问题',
            status: 'open',
          },
        ],
      },
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: ctx.projectId,
        agentId: 'reviewer-case',
        sessionId: 'finding-cases-proj-1',
      }),
      'flush'
    );

    await transport.close();
    await server.stop();
  });
});

describe('EverOSMcpServer owner 注册', () => {
  it('项目知识和 finding case 写入会登记所属 Agent', async () => {
    vi.mocked(everosMemoryAddMessages).mockReset().mockResolvedValue(undefined);
    vi.mocked(everosMemoryFlush).mockReset().mockResolvedValue(undefined);
    const onMemoryOwners = vi.fn();
    const server = new EverOSMcpServer({
      everosUrl: 'http://127.0.0.1:9999',
      onMemoryOwners,
    });
    const url = await server.start();
    const client = new Client({ name: 'owner-test', version: '0.1.0' });
    const transport = new SSEClientTransport(new URL('/sse', url));
    await client.connect(transport);

    const archiverCtx = makeCtx({ agentId: 'archiver', agentDisplayName: 'Archiver' });
    await client.callTool({
      name: 'record_project_knowledge',
      arguments: {
        context: archiverCtx,
        items: [
          {
            id: 'knowledge-example',
            category: 'architecture',
            sourceFiles: ['src/example.ts'],
            content: '示例架构知识',
            confidence: 'high',
            createdAt: '2026-07-20T00:00:00.000Z',
          },
        ],
      },
    });
    await client.callTool({
      name: 'record_finding_cases',
      arguments: {
        context: makeCtx(),
        cases: [
          {
            key: 'case:example',
            mrIid: 1,
            file: 'src/example.ts',
            line: 12,
            severity: 'HIGH',
            message: '示例问题',
            status: 'open',
          },
        ],
      },
    });

    expect(onMemoryOwners).toHaveBeenCalledWith('proj-1', [
      expect.objectContaining({ ownerId: 'archiver', ownerType: 'agent' }),
    ]);
    expect(onMemoryOwners).toHaveBeenCalledWith('proj-1', [
      expect.objectContaining({ ownerId: 'reviewer-case', ownerType: 'agent' }),
    ]);

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

    const ownerIds = result.owners.map(o => o.ownerId);
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

    const ownerIds = result.owners.map(o => o.ownerId);
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

    const ownerIds = result.owners.map(o => o.ownerId);
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

    const userOwners = result.owners.filter(o => o.ownerType === 'user');
    expect(userOwners).toHaveLength(0);
  });
});

describe('formatFindingCaseContent', () => {
  it('生成带 [CASE:key] 标记的结构化文本', () => {
    const content = formatFindingCaseContent({
      key: 'case:p1:mr-1:src_a_ts:10:rule-any',
      mrIid: 1,
      file: 'src/a.ts',
      line: 10,
      severity: 'HIGH',
      ruleId: 'rule-any',
      message: '问题',
      suggestion: '建议',
      status: 'open',
      discussionId: 'd-1',
    });
    expect(content).toContain('[CASE:case:p1:mr-1:src_a_ts:10:rule-any]');
    expect(content).toContain('文件: src/a.ts');
    expect(content).toContain('状态: open');
    expect(content).toContain('讨论ID: d-1');
  });
});

describe('EverOSMcpServer finding case tools', () => {
  async function connect(
    server: EverOSMcpServer
  ): Promise<{ client: Client; transport: SSEClientTransport; url: string }> {
    const url = await server.start();
    const client = new Client({ name: 'test', version: '0.1.0' });
    const transport = new SSEClientTransport(new URL('/sse', url));
    await client.connect(transport);
    return { client, transport, url };
  }

  beforeEach(() => {
    vi.mocked(everosMemoryAdd).mockReset();
    vi.mocked(everosMemoryAddMessages).mockReset();
    vi.mocked(everosMemoryFlush).mockReset();
  });

  it('record_finding_cases 使用专用 session 与 sender 写入并 flush', async () => {
    vi.mocked(everosMemoryAddMessages).mockResolvedValue(undefined);
    vi.mocked(everosMemoryFlush).mockResolvedValue(undefined);

    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999' });
    const { client, transport } = await connect(server);

    const ctx = makeCtx();
    await client.callTool({
      name: 'record_finding_cases',
      arguments: {
        context: ctx,
        cases: [
          {
            key: 'case:proj-1:mr-1:src_a_ts:10:rule-any',
            mrIid: 1,
            file: 'src/a.ts',
            line: 10,
            severity: 'HIGH',
            ruleId: 'rule-any',
            message: '问题',
            suggestion: '建议',
            status: 'open',
          },
        ],
      },
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(everosMemoryAddMessages).toHaveBeenCalledTimes(1);
    const call = vi.mocked(everosMemoryAddMessages).mock.calls[0];
    expect(call[1]).toMatchObject({
      appId: ctx.appId,
      projectId: ctx.projectId,
      sessionId: 'finding-cases-proj-1',
    });
    expect(call[2]).toEqual([
      {
        senderId: 'reviewer-case',
        role: 'assistant',
        content: expect.stringContaining('[CASE:case:proj-1:mr-1:src_a_ts:10:rule-any]'),
      },
    ]);
    expect(everosMemoryFlush).toHaveBeenCalledTimes(1);

    await transport.close();
    await server.stop();
  });

  it('flush_session 调用 everosMemoryFlush', async () => {
    vi.mocked(everosMemoryFlush).mockResolvedValue(undefined);

    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999' });
    const { client, transport } = await connect(server);

    const ctx = makeCtx({ sessionId: 'sess-flush' });
    await client.callTool({
      name: 'flush_session',
      arguments: { context: ctx },
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(everosMemoryFlush).toHaveBeenCalledTimes(1);
    expect(everosMemoryFlush).toHaveBeenCalledWith(
      'http://127.0.0.1:9999',
      expect.objectContaining({
        appId: ctx.appId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
      })
    );

    await transport.close();
    await server.stop();
  });

  it('Maintainer 反思写入完成后才返回，并立即 flush 当前 session', async () => {
    vi.mocked(everosMemoryAdd).mockResolvedValue(undefined);
    vi.mocked(everosMemoryFlush).mockResolvedValue(undefined);

    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999' });
    const { client, transport } = await connect(server);
    const ctx = makeCtx({
      agentId: 'maintainer',
      agentDisplayName: 'Maintainer',
      sessionId: 'maintainer-proj-1-mr-1',
    });

    await client.callTool({
      name: 'record_reflection',
      arguments: {
        context: ctx,
        caseKey: 'case:proj-1:mr-1:src_a_ts:10:rule-any',
        reflection: '修复后应保留默认路径覆盖',
        outcome: 'success',
      },
    });

    expect(everosMemoryAdd).not.toHaveBeenCalled();
    expect(everosMemoryAddMessages).toHaveBeenCalledTimes(1);
    expect(everosMemoryAddMessages).toHaveBeenCalledWith(
      'http://127.0.0.1:9999',
      expect.objectContaining({
        appId: ctx.appId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
      }),
      [
        expect.objectContaining({
          senderId: 'maintainer',
          role: 'user',
          content: '系统记录以下维护记忆，请将其纳入项目记忆。',
        }),
        expect.objectContaining({
          senderId: 'maintainer',
          role: 'assistant',
          content: expect.stringContaining('[CASE:case:proj-1:mr-1:src_a_ts:10:rule-any]'),
        }),
      ]
    );
    expect(everosMemoryFlush).toHaveBeenCalledTimes(1);
    expect(everosMemoryFlush).toHaveBeenCalledWith(
      'http://127.0.0.1:9999',
      expect.objectContaining({
        appId: ctx.appId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
      })
    );

    await transport.close();
    await server.stop();
  });

  it('flush_session 失败时入队 flush 任务', async () => {
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
      name: 'flush_session',
      arguments: { context: ctx },
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(ctx, 'flush');

    await transport.close();
    await server.stop();
  });

  it('recall_finding_case 按 reviewer-case owner 搜索', async () => {
    const { everosMemorySearch } =
      await import('../../../../src/advance/classic/memory/everos-api.js');
    vi.mocked(everosMemorySearch).mockResolvedValue({
      items: [
        {
          id: 'c1',
          type: 'episode',
          content: '[CASE:case:proj-1:mr-1:src_a_ts:10:rule-any]\n状态: open',
          score: 0.9,
        },
      ],
    });

    const server = new EverOSMcpServer({ everosUrl: 'http://127.0.0.1:9999' });
    const { client, transport } = await connect(server);

    const ctx = makeCtx();
    const result = await client.callTool({
      name: 'recall_finding_case',
      arguments: {
        context: ctx,
        key: 'case:proj-1:mr-1:src_a_ts:10:rule-any',
      },
    });

    expect(everosMemorySearch).toHaveBeenCalledWith(
      'http://127.0.0.1:9999',
      expect.objectContaining({
        appId: ctx.appId,
        projectId: ctx.projectId,
        owner: { kind: 'agent', agentId: 'reviewer-case' },
        query: 'case:proj-1:mr-1:src_a_ts:10:rule-any',
      })
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: expect.stringContaining('状态: open') }],
    });

    await transport.close();
    await server.stop();
  });
});
