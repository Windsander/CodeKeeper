import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryClient } from '../../../../src/advance/classic/memory/memory-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const mockContext = {
  appId: 'codekeeper-advance',
  projectId: 'p1',
  agentId: 'reviewer',
  userId: 'alice',
  sessionId: 'mr-1',
};

describe('MemoryClient', () => {
  it('保存并清洗上下文', () => {
    const client = new MemoryClient({ mcpUrl: 'http://127.0.0.1:9999', context: mockContext });
    expect(client.context).toEqual(mockContext);
  });

  it('清洗不合法字符', () => {
    const client = new MemoryClient({
      mcpUrl: 'http://127.0.0.1:9999',
      context: {
        ...mockContext,
        projectId: 'D:/project/path',
      },
    });
    expect(client.context.projectId).toBe('D__project_path');
  });
});

describe('MemoryClient 记录方法', () => {
  let client: MemoryClient;
  let callToolSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new MemoryClient({ mcpUrl: 'http://127.0.0.1:9999', context: mockContext });
    callToolSpy = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [] });
  });

  afterEach(() => {
    callToolSpy.mockRestore();
  });

  it('recordFixAttempt 调用 record_fix_attempt tool', async () => {
    await client.recordFixAttempt({ mrIid: 42, file: 'src/index.ts', line: 10, success: true, reason: '已修复' });
    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'record_fix_attempt',
      arguments: {
        context: mockContext,
        mrIid: 42,
        file: 'src/index.ts',
        line: 10,
        success: true,
        reason: '已修复',
      },
    });
  });

  it('recordInteraction 调用 record_interaction tool', async () => {
    await client.recordInteraction({ discussionId: 'd-1', userId: 'bob', decision: 'fix', outcome: 'success' });
    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'record_interaction',
      arguments: {
        context: mockContext,
        discussionId: 'd-1',
        userId: 'bob',
        decision: 'fix',
        outcome: 'success',
      },
    });
  });

  it('recordReview 传递 findings', async () => {
    const findings = [{ file: 'a.ts', line: 1, message: '问题' }];
    await client.recordReview({ mrIid: 1, title: 'MR', findingsCount: 1, summary: 'ok', findings });
    expect(callToolSpy).toHaveBeenCalledWith({
      name: 'record_review',
      arguments: {
        context: mockContext,
        mrIid: 1,
        title: 'MR',
        findingsCount: 1,
        summary: 'ok',
        findings,
      },
    });
  });

  it('tool 调用失败时抛出异常', async () => {
    vi.spyOn(Client.prototype, 'callTool').mockRejectedValue(new Error('MCP 断开'));
    const testClient = new MemoryClient({ mcpUrl: 'http://127.0.0.1:9999', context: mockContext });
    await expect(testClient.recordReview({ mrIid: 1, title: 'MR', findingsCount: 0, summary: 'ok' })).rejects.toThrow('MCP 断开');
  });

  it('tool 返回 isError 时抛出异常', async () => {
    vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'invalid' }], isError: true });
    const testClient = new MemoryClient({ mcpUrl: 'http://127.0.0.1:9999', context: mockContext });
    await expect(testClient.recordReview({ mrIid: 1, title: 'MR', findingsCount: 0, summary: 'ok' })).rejects.toThrow('invalid');
  });
});
