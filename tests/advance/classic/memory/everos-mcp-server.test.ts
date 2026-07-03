import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  EverOSMcpServer,
  buildReviewMemoryMessages,
} from '../../../../src/advance/classic/memory/everos-mcp-server.js';
import type { MemoryContext, MemoryReviewComment } from '../../../../src/advance/classic/memory/types.js';

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
