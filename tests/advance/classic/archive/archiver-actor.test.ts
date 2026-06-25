import { describe, it, expect, vi } from 'vitest';
import { ArchiverActor } from '../../../../src/advance/classic/archive/archiver-actor.js';

describe('ArchiverActor', () => {
  it('空知识数组不调用 memoryClient', async () => {
    const memoryClient = { recordProjectKnowledge: vi.fn() } as unknown as Parameters<typeof ArchiverActor>[0]['memoryClient'];
    const actor = new ArchiverActor({ memoryClient });
    await actor.storeKnowledge([]);
    expect(memoryClient.recordProjectKnowledge).not.toHaveBeenCalled();
  });

  it('有知识时写入 memoryClient', async () => {
    const memoryClient = { recordProjectKnowledge: vi.fn() } as unknown as Parameters<typeof ArchiverActor>[0]['memoryClient'];
    const actor = new ArchiverActor({ memoryClient });
    await actor.storeKnowledge([{ id: 'k1', category: 'stack', sourceFiles: [], content: 'TS', confidence: 'high', createdAt: '2026-01-01' }]);
    expect(memoryClient.recordProjectKnowledge).toHaveBeenCalledWith(expect.any(Array));
  });
});
