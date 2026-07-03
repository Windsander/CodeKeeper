import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryWriteQueue } from '../../../../src/advance/classic/memory/memory-write-queue';
import type { MetadataStore } from '../../../../src/advance/store/metadata-store';
import type { MemoryContext } from '../../../../src/advance/classic/memory/types';
import type { EverOSAddMessage } from '../../../../src/advance/classic/memory/everos-api';

describe('MemoryWriteQueue', () => {
  let store: Pick<
    MetadataStore,
    'insertPendingMemoryWrite' | 'listPendingMemoryWrites' | 'deletePendingMemoryWrite' | 'incrementPendingMemoryFailure'
  >;
  let queue: MemoryWriteQueue;
  const ctx: MemoryContext = {
    appId: 'app',
    projectId: 'proj',
    agentId: 'agent',
    agentDisplayName: 'Agent',
    userId: 'user',
    sessionId: 'sess',
  };

  beforeEach(() => {
    store = {
      insertPendingMemoryWrite: vi.fn(),
      listPendingMemoryWrites: vi.fn().mockReturnValue([]),
      deletePendingMemoryWrite: vi.fn(),
      incrementPendingMemoryFailure: vi.fn(),
    };
    queue = new MemoryWriteQueue({ store, maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 });
  });

  it('enqueue 把 add_messages 任务落库', () => {
    const messages: EverOSAddMessage[] = [{ senderId: 'u', role: 'user', content: 'hi' }];
    queue.enqueue(ctx, 'add_messages', messages);

    expect(store.insertPendingMemoryWrite).toHaveBeenCalledTimes(1);
    const call = vi.mocked(store.insertPendingMemoryWrite).mock.calls[0][0];
    expect(call.projectId).toBe('proj');
    expect(call.kind).toBe('add_messages');
    expect(call.messages).toEqual(messages);
    expect(call.failureCount).toBe(1);
    expect(call.nextRetryAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('enqueue 把 flush 任务落库', () => {
    queue.enqueue(ctx, 'flush');

    expect(store.insertPendingMemoryWrite).toHaveBeenCalledTimes(1);
    const call = vi.mocked(store.insertPendingMemoryWrite).mock.calls[0][0];
    expect(call.kind).toBe('flush');
    expect(call.messages).toEqual([]);
  });

  it('相同 content hash 入队时 id 相同，由 store 去重合并', () => {
    const messages: EverOSAddMessage[] = [{ senderId: 'u', role: 'user', content: 'hi' }];
    queue.enqueue(ctx, 'add_messages', messages);
    queue.enqueue(ctx, 'add_messages', messages);

    expect(store.insertPendingMemoryWrite).toHaveBeenCalledTimes(2);
    const first = vi.mocked(store.insertPendingMemoryWrite).mock.calls[0][0];
    const second = vi.mocked(store.insertPendingMemoryWrite).mock.calls[1][0];
    expect(first.id).toBe(second.id);
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('listReady 透传 store 查询结果', () => {
    const writes = [
      { id: 'w1', nextRetryAt: 1, failureCount: 1, kind: 'add_messages' as const, messages: [], projectId: 'proj' },
    ];
    store.listPendingMemoryWrites = vi.fn().mockReturnValue(writes);

    const result = queue.listReady(1234, 5);
    expect(result).toBe(writes);
    expect(store.listPendingMemoryWrites).toHaveBeenCalledWith({ now: 1234, limit: 5 });
  });

  it('remove 删除任务', () => {
    queue.remove('w1');
    expect(store.deletePendingMemoryWrite).toHaveBeenCalledWith('w1');
  });

  it('markFailed 未达上限时更新下次重试时间', () => {
    const now = Date.now();
    queue.markFailed('w1', 1, 'boom');

    expect(store.incrementPendingMemoryFailure).toHaveBeenCalledTimes(1);
    const [, nextRetryAt, error] = vi.mocked(store.incrementPendingMemoryFailure).mock.calls[0];
    expect(error).toBe('boom');
    expect(nextRetryAt).toBeGreaterThanOrEqual(now + 100);
  });

  it('markFailed 达到上限时删除任务', () => {
    queue.markFailed('w1', 3, 'boom');

    expect(store.incrementPendingMemoryFailure).not.toHaveBeenCalled();
    expect(store.deletePendingMemoryWrite).toHaveBeenCalledWith('w1');
  });

  it('nextDelayMs 按指数退避计算', () => {
    expect(queue.nextDelayMs(1)).toBe(100);
    expect(queue.nextDelayMs(2)).toBe(200);
    expect(queue.nextDelayMs(3)).toBe(400);
    expect(queue.nextDelayMs(10)).toBe(1000); // 受 maxDelayMs 限制
  });
});
