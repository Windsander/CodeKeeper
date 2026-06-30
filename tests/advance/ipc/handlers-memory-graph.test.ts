import { describe, it, expect, vi } from 'vitest';
import { handlers } from '../../../src/advance/ipc/handlers.js';

describe('memory.graph handler', () => {
  it('EverOS 未启动时抛错', async () => {
    const ctx = {
      everosUrl: null,
      registry: { list: vi.fn().mockReturnValue([]) },
    } as any;
    await expect(handlers['memory.graph'](ctx, {})).rejects.toThrow('EverOS 服务未启动');
  });
});
