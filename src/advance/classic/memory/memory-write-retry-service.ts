import { logger } from '../../../core/logger.js';
import { everosMemoryAddMessages, everosMemoryFlush } from './everos-api.js';
import type { MemoryContext } from './types.js';
import type { IMemoryWriteQueue, PendingMemoryWrite } from './memory-write-queue.js';

export interface MemoryWriteRetryServiceOptions {
  queue: IMemoryWriteQueue;
  /** 获取当前 EverOS HTTP URL；未启动时返回 undefined */
  getEverosUrl: () => string | undefined;
  /** 轮询间隔毫秒，默认 30000 */
  intervalMs?: number;
  /** 单次处理任务上限，默认 50 */
  batchSize?: number;
}

const DEFAULT_OPTIONS: Required<Omit<MemoryWriteRetryServiceOptions, 'queue' | 'getEverosUrl'>> = {
  intervalMs: 30000,
  batchSize: 50,
};

/**
 * 失败记忆写入的后台重试服务。
 *
 * 周期性从 MemoryWriteQueue 拉取到期任务，直接调用 EverOS HTTP API 重放，
 * 成功则删除任务，失败则更新下次重试时间或丢弃（超过最大次数）。
 */
export class MemoryWriteRetryService {
  private readonly queue: IMemoryWriteQueue;
  private readonly getEverosUrl: () => string | undefined;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly processingIds = new Set<string>();

  constructor(options: MemoryWriteRetryServiceOptions) {
    this.queue = options.queue;
    this.getEverosUrl = options.getEverosUrl;
    const { intervalMs, batchSize } = { ...DEFAULT_OPTIONS, ...options };
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, 'MemoryWriteRetryService tick 异常');
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const url = this.getEverosUrl();
    if (!url) {
      return;
    }

    const writes = this.queue.listReady(Date.now(), this.batchSize);
    if (writes.length === 0) return;

    logger.info({ count: writes.length }, '开始重试失败的记忆写入');

    for (const write of writes) {
      if (this.processingIds.has(write.id)) continue;
      this.processingIds.add(write.id);
      this.retryOne(url, write)
        .catch((err) => {
          logger.error({ err, writeId: write.id }, '重试单条记忆写入时未捕获异常');
        })
        .finally(() => {
          this.processingIds.delete(write.id);
        });
    }
  }

  private async retryOne(url: string, write: PendingMemoryWrite): Promise<void> {
    const ctx: MemoryContext = {
      appId: write.appId,
      projectId: write.projectId,
      agentId: write.agentId,
      agentDisplayName: write.agentDisplayName,
      userId: write.userId,
      sessionId: write.sessionId,
    };

    try {
      if (write.kind === 'add_messages') {
        await everosMemoryAddMessages(url, ctx, write.messages);
      } else {
        await everosMemoryFlush(url, ctx);
      }
      this.queue.remove(write.id);
      logger.info({ writeId: write.id, kind: write.kind }, '失败记忆写入重试成功');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, writeId: write.id, kind: write.kind }, `记忆写入重试失败: ${message}`);
      this.queue.markFailed(write.id, write.failureCount, message);
    }
  }
}
