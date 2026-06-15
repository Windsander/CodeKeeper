import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectStatus } from '../types';

export interface StatusUpdaterOptions {
  projectRoot: string;
  status: ProjectStatus;
}

/**
 * 原子写入 .codekeeper/status.json
 */
export function updateStatus(options: StatusUpdaterOptions): void {
  const dir = join(options.projectRoot, '.codekeeper');
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
  suggestionCount: number;
}): ProjectStatus {
  const total = params.pendingCount + params.archivedCount + params.ignoredCount;
  const healthScore = total === 0 ? 1 : Math.round(((params.archivedCount + params.ignoredCount) / total) * 100) / 100;
  return {
    schemaVersion: 1,
    projectId: params.projectId,
    lastScannedAt: params.lastScannedAt,
    lastScannedAtIso: new Date(params.lastScannedAt).toISOString(),
    scanStatus: params.scanStatus,
    totalCount: total,
    pendingCount: params.pendingCount,
    archivedCount: params.archivedCount,
    ignoredCount: params.ignoredCount,
    healthScore,
    healthScoreDefinition: '已归档与已忽略条目占总条目数的比例，1.0 表示全部处理完毕',
    suggestionCount: params.suggestionCount,
  };
}
