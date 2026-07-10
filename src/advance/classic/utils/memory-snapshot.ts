import { logger } from '../../../core/logger.js';

/**
 * 打印当前进程内存快照，使用同步日志确保崩溃前能刷出。
 */
export function logMemorySnapshot(label: string): void {
  const usage = process.memoryUsage();
  const snapshot = {
    label,
    rssMB: Math.round(usage.rss / 1024 / 1024),
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
    externalMB: Math.round(usage.external / 1024 / 1024),
  };
  // 使用 console.log 同步输出，避免 pino 异步缓冲在 OOM 前丢失
  console.log(`[memory-snapshot] ${label} rss=${snapshot.rssMB}MB heapUsed=${snapshot.heapUsedMB}MB heapTotal=${snapshot.heapTotalMB}MB external=${snapshot.externalMB}MB`);
  logger.debug(snapshot, '内存快照');
}
