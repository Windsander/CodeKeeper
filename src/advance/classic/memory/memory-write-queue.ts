import { createHash } from 'node:crypto';
import type { MetadataStore } from '../../store/metadata-store';
import type { EverOSAddMessage } from './everos-api';
import type { MemoryContext } from './types';

export type PendingMemoryWriteKind = 'add_messages' | 'flush';

export interface PendingMemoryWrite {
  id: string;
  projectId: string;
  appId: string;
  agentId: string;
  agentDisplayName?: string;
  userId: string;
  sessionId: string;
  kind: PendingMemoryWriteKind;
  messages: EverOSAddMessage[];
  contentHash: string;
  failureCount: number;
  lastError?: string;
  nextRetryAt: number;
  createdAt: number;
}

export interface MemoryWriteQueueOptions {
  store: MetadataStore;
  /** 最大重试次数，默认 10 */
  maxRetries?: number;
  /** 首次重试等待毫秒数，默认 1000 */
  baseDelayMs?: number;
  /** 最大重试等待毫秒数，默认 60000 */
  maxDelayMs?: number;
}

export interface IMemoryWriteQueue {
  enqueue(ctx: MemoryContext, kind: 'flush'): void;
  enqueue(ctx: MemoryContext, kind: 'add_messages', messages: EverOSAddMessage[]): void;
  listReady(now?: number, limit?: number): PendingMemoryWrite[];
  remove(id: string): void;
  markFailed(id: string, currentFailureCount: number, error: string): void;
}

const DEFAULT_OPTIONS: Required<Omit<MemoryWriteQueueOptions, 'store'>> = {
  maxRetries: 10,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

/**
 * 失败记忆写入的持久化队列。
 *
 * 把 EverOS 写入失败的操作落库，由后台服务周期性重试，直到成功或耗尽次数。
 * 同一 session + 相同内容哈希的任务会去重合并，避免队列无限膨胀。
 */
export class MemoryWriteQueue implements IMemoryWriteQueue {
  private readonly store: MetadataStore;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: MemoryWriteQueueOptions) {
    this.store = options.store;
    const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTIONS, ...options };
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  /**
   * 把失败的 flush 操作入队。
   */
  enqueue(ctx: MemoryContext, kind: 'flush'): void;

  /**
   * 把失败的 add_messages 操作入队。
   */
  enqueue(ctx: MemoryContext, kind: 'add_messages', messages: EverOSAddMessage[]): void;

  enqueue(
    ctx: MemoryContext,
    kind: PendingMemoryWriteKind,
    messages?: EverOSAddMessage[]
  ): void {
    const msgs = messages ?? [];
    const contentHash = this.computeContentHash(ctx.sessionId, kind, msgs);
    const id = this.buildId(ctx.projectId, ctx.sessionId, contentHash);
    const now = Date.now();
    const nextRetryAt = now + this.nextDelayMs(1);

    this.store.insertPendingMemoryWrite({
      id,
      projectId: ctx.projectId,
      appId: ctx.appId,
      agentId: ctx.agentId,
      agentDisplayName: ctx.agentDisplayName,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      kind,
      messages: msgs,
      contentHash,
      failureCount: 1,
      nextRetryAt,
      createdAt: now,
    });
  }

  /**
   * 拉取到期的待重试任务。
   */
  listReady(now?: number, limit?: number): PendingMemoryWrite[] {
    return this.store.listPendingMemoryWrites({ now, limit });
  }

  /**
   * 删除已成功的任务。
   */
  remove(id: string): void {
    this.store.deletePendingMemoryWrite(id);
  }

  /**
   * 标记某次重试失败。
   * 若已达最大重试次数则删除任务；否则更新下次重试时间。
   */
  markFailed(id: string, currentFailureCount: number, error: string): void {
    if (currentFailureCount >= this.maxRetries) {
      this.store.deletePendingMemoryWrite(id);
      return;
    }
    const nextFailureCount = currentFailureCount + 1;
    const nextRetryAt = Date.now() + this.nextDelayMs(nextFailureCount);
    this.store.incrementPendingMemoryFailure(id, nextRetryAt, error);
  }

  /**
   * 计算下一次重试的延迟毫秒数（指数退避）。
   */
  nextDelayMs(failureCount: number): number {
    const exponent = Math.max(0, failureCount - 1);
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  private computeContentHash(
    sessionId: string,
    kind: PendingMemoryWriteKind,
    messages: EverOSAddMessage[]
  ): string {
    const payload = `${sessionId}:${kind}:${JSON.stringify(messages)}`;
    return createHash('sha256').update(payload).digest('hex');
  }

  private buildId(projectId: string, sessionId: string, contentHash: string): string {
    return `${projectId}:${sessionId}:${contentHash}`;
  }
}
