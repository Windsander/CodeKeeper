import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectStatus } from '../types';

export interface StatusUpdaterOptions {
  archiveRoot: string;
  status: ProjectStatus;
}

/**
 * 原子写入 status.json 到归档位置
 */
export function updateStatus(options: StatusUpdaterOptions): void {
  const dir = options.archiveRoot;
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, 'status.json.tmp');
  const finalPath = join(dir, 'status.json');
  writeFileSync(tmpPath, JSON.stringify(options.status, null, 2) + '\n', 'utf-8');
  // 原子重命名避免并发写入产生半写文件
  renameSync(tmpPath, finalPath);
}

/**
 * 构建完整的 ProjectStatus 对象
 */
export function buildProjectStatus(params: {
  projectId: string;
  lastScannedAt: number;
  scanStatus: 'success' | 'partial' | 'failed';
  pendingCount: number;
  archivedCount: number;
  ignoredCount: number;
  orphanedCount: number;
  copiedCount: number;
  organizedCount: number;
  flaggedCount: number;
}): ProjectStatus {
  const total = params.pendingCount + params.archivedCount + params.ignoredCount + params.orphanedCount;
  const resolved = params.archivedCount + params.ignoredCount + params.orphanedCount;
  const healthScore = total === 0 ? 1 : Math.round((resolved / total) * 100) / 100;
  return {
    schemaVersion: 2,
    projectId: params.projectId,
    lastScannedAt: params.lastScannedAt,
    lastScannedAtIso: new Date(params.lastScannedAt).toISOString(),
    scanStatus: params.scanStatus,
    totalCount: total,
    pendingCount: params.pendingCount,
    archivedCount: params.archivedCount,
    ignoredCount: params.ignoredCount,
    orphanedCount: params.orphanedCount,
    copiedCount: params.copiedCount,
    organizedCount: params.organizedCount,
    flaggedCount: params.flaggedCount,
    healthScore,
    healthScoreDefinition: '已归档、已忽略、已孤儿条目占总条目数的比例，1.0 表示全部处理完毕',
  };
}
