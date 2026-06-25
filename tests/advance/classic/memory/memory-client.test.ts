import { describe, it, expect } from 'vitest';
import { MemoryClient } from '../../../../src/advance/classic/memory/memory-client.js';

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
