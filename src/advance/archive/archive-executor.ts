import { copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ArchiveAction } from '../types';
import { isWithinArchiveRoot } from './archive-path';

export interface ExecutionResult {
  /** 是否成功执行 */
  success: boolean;
  /** 归档侧最终路径 */
  finalArchivePath?: string;
  /** 错误信息 */
  error?: string;
}

export interface ArchiveExecutorOptions {
  /** 归档根目录 */
  archiveRoot: string;
}

/**
 * 归档执行器：复制原文件到归档根目录，或在归档根目录内重新组织
 */
export class ArchiveExecutor {
  constructor(private options: ArchiveExecutorOptions) {}

  async execute(action: ArchiveAction): Promise<ExecutionResult> {
    try {
      switch (action.type) {
        case 'copy':
          return this.executeCopy(action);
        case 'organize':
          return this.executeOrganize(action);
        case 'ignore':
          return { success: true };
        case 'flag':
          return this.executeFlag(action);
        default:
          return { success: false, error: `未知动作类型: ${action.type}` };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private executeCopy(action: ArchiveAction): ExecutionResult {
    const target = action.targetPath;
    if (!target) {
      return { success: false, error: '缺少 targetPath' };
    }

    if (!isWithinArchiveRoot(this.options.archiveRoot, target)) {
      return { success: false, error: '目标路径必须在归档根目录内' };
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(action.sourcePath, target);
    return { success: true, finalArchivePath: target };
  }

  private executeOrganize(action: ArchiveAction): ExecutionResult {
    const source = action.sourcePath;
    const target = action.targetPath;
    if (!target) {
      return { success: false, error: '缺少 targetPath' };
    }

    if (!isWithinArchiveRoot(this.options.archiveRoot, source)) {
      return { success: false, error: '源路径必须在归档根目录内' };
    }
    if (!isWithinArchiveRoot(this.options.archiveRoot, target)) {
      return { success: false, error: '目标路径必须在归档根目录内' };
    }

    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    return { success: true, finalArchivePath: target };
  }

  private executeFlag(action: ArchiveAction): ExecutionResult {
    const target = action.targetPath;
    if (!target) {
      return { success: false, error: '缺少 targetPath' };
    }

    if (!isWithinArchiveRoot(this.options.archiveRoot, target)) {
      return { success: false, error: '目标路径必须在归档根目录内' };
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(action.sourcePath, target);
    return { success: true, finalArchivePath: target };
  }
}
