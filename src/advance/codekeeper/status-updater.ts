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
