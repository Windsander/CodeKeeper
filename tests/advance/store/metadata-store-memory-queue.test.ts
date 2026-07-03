import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../../../src/advance/store/metadata-store';

describe('MetadataStore pending_memory_writes', () => {
  let store: MetadataStore;

  beforeEach(() => {
    store = new MetadataStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function sampleWrite(overrides: Partial<Parameters<MetadataStore['insertPendingMemoryWrite']>[0]> = {}) {
    return {
      id: 'id-1',
      projectId: 'proj-1',
      appId: 'app',
      agentId: 'agent',
      agentDisplayName: 'Agent Name',
      userId: 'user',
      sessionId: 'session-1',
      kind: 'add_messages' as const,
      messages: [{ senderId: 'user', role: 'user' as const, content: 'hello', timestamp: 1000 }],
      contentHash: 'hash-1',
      failureCount: 1,
      lastError: 'error',
      nextRetryAt: 1000,
      createdAt: 1000,
      ...overrides,
    };
  }

  it('插入并读取待重试任务', () => {
    store.insertPendingMemoryWrite(sampleWrite());

    const ready = store.listPendingMemoryWrites({ now: 2000, limit: 10 });
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({
      id: 'id-1',
      projectId: 'proj-1',
      kind: 'add_messages',
      failureCount: 1,
      lastError: 'error',
    });
    expect(ready[0].messages).toEqual([
      { senderId: 'user', role: 'user', content: 'hello', timestamp: 1000 },
    ]);
  });

  it('相同 content_hash 重复入队会合并并累加 failure_count', () => {
    store.insertPendingMemoryWrite(sampleWrite({ failureCount: 1, nextRetryAt: 1000 }));
    store.insertPendingMemoryWrite(sampleWrite({ failureCount: 2, nextRetryAt: 2000, lastError: 'error-2' }));

    const ready = store.listPendingMemoryWrites({ now: 3000, limit: 10 });
    expect(ready).toHaveLength(1);
    expect(ready[0].failureCount).toBe(2);
    expect(ready[0].nextRetryAt).toBe(2000);
    expect(ready[0].lastError).toBe('error-2');
  });

  it('listPendingMemoryWrites 只返回已到重试时间的任务', () => {
    store.insertPendingMemoryWrite(sampleWrite({ id: 'a', nextRetryAt: 1000 }));
    store.insertPendingMemoryWrite(sampleWrite({ id: 'b', contentHash: 'hash-2', nextRetryAt: 3000 }));

    const ready = store.listPendingMemoryWrites({ now: 2000, limit: 10 });
    expect(ready.map((w) => w.id)).toEqual(['a']);
  });

  it('incrementPendingMemoryFailure 更新失败次数与下次重试时间', () => {
    store.insertPendingMemoryWrite(sampleWrite());
    store.incrementPendingMemoryFailure('id-1', 5000, 'boom');

    const ready = store.listPendingMemoryWrites({ now: 6000, limit: 10 });
    expect(ready).toHaveLength(1);
    expect(ready[0].failureCount).toBe(2);
    expect(ready[0].nextRetryAt).toBe(5000);
    expect(ready[0].lastError).toBe('boom');
  });

  it('deletePendingMemoryWrite 删除任务', () => {
    store.insertPendingMemoryWrite(sampleWrite());
    store.deletePendingMemoryWrite('id-1');

    const ready = store.listPendingMemoryWrites({ now: 2000, limit: 10 });
    expect(ready).toHaveLength(0);
  });
});
