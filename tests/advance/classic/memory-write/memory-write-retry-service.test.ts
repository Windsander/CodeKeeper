import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryWriteRetryService } from '../../../../src/advance/classic/memory/memory-write-retry-service';
import type {
  IMemoryWriteQueue,
  PendingMemoryWrite,
} from '../../../../src/advance/classic/memory/memory-write-queue';
import {
  everosMemoryAddMessages,
  everosMemoryFlush,
} from '../../../../src/advance/classic/memory/everos-api';

vi.mock('../../../../src/advance/classic/memory/everos-api.js', () => ({
  everosMemoryAddMessages: vi.fn(),
  everosMemoryFlush: vi.fn(),
}));

describe('MemoryWriteRetryService', () => {
  let queue: IMemoryWriteQueue;
  let getEverosUrl: ReturnType<typeof vi.fn>;
  let service: MemoryWriteRetryService;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = {
      enqueue: vi.fn(),
      listReady: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      markFailed: vi.fn(),
    };
    getEverosUrl = vi.fn().mockReturnValue('http://everos:8000');
    service = new MemoryWriteRetryService({
      queue,
      getEverosUrl,
      intervalMs: 5000,
      batchSize: 10,
    });
    vi.mocked(everosMemoryAddMessages).mockReset();
    vi.mocked(everosMemoryFlush).mockReset();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function sampleWrite(overrides: Partial<PendingMemoryWrite> = {}): PendingMemoryWrite {
    return {
      id: 'w1',
      projectId: 'proj',
      appId: 'app',
      agentId: 'agent',
      userId: 'user',
      sessionId: 'sess',
      kind: 'add_messages',
      messages: [{ senderId: 'u', role: 'user', content: 'hi' }],
      contentHash: 'hash',
      failureCount: 1,
      nextRetryAt: 1,
      createdAt: 1,
      ...overrides,
    };
  }

  it('EverOS URL 未就绪时不拉取任务', async () => {
    getEverosUrl.mockReturnValue(undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(queue.listReady).not.toHaveBeenCalled();
  });

  it('add_messages 任务成功时删除任务', async () => {
    const write = sampleWrite();
    queue.listReady = vi.fn().mockReturnValue([write]);
    vi.mocked(everosMemoryAddMessages).mockResolvedValue(undefined);

    service.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(everosMemoryAddMessages).toHaveBeenCalledWith(
      'http://everos:8000',
      expect.objectContaining({ projectId: 'proj', sessionId: 'sess' }),
      write.messages
    );
    expect(queue.remove).toHaveBeenCalledWith('w1');
    expect(queue.markFailed).not.toHaveBeenCalled();
  });

  it('add_messages 成功但 flush 失败时转为独立 flush 任务', async () => {
    const write = sampleWrite();
    queue.listReady = vi.fn().mockReturnValue([write]);
    vi.mocked(everosMemoryAddMessages).mockResolvedValue(undefined);
    vi.mocked(everosMemoryFlush).mockRejectedValue(new Error('flush boom'));

    service.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(everosMemoryAddMessages).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj', sessionId: 'sess' }),
      'flush'
    );
    expect(queue.remove).toHaveBeenCalledWith('w1');
    expect(queue.markFailed).not.toHaveBeenCalled();
  });

  it('flush 任务失败时更新任务状态', async () => {
    const write = sampleWrite({ kind: 'flush', messages: [] });
    queue.listReady = vi.fn().mockReturnValue([write]);
    vi.mocked(everosMemoryFlush).mockRejectedValue(new Error('flush boom'));

    service.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(everosMemoryFlush).toHaveBeenCalledWith(
      'http://everos:8000',
      expect.objectContaining({ projectId: 'proj', sessionId: 'sess' })
    );
    expect(queue.markFailed).toHaveBeenCalledWith('w1', 1, 'flush boom');
    expect(queue.remove).not.toHaveBeenCalled();
  });

  it('按 intervalMs 周期性触发 tick', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(queue.listReady).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(queue.listReady).toHaveBeenCalledTimes(2);
  });
});
