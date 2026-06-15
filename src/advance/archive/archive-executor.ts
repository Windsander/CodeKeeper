import { mkdirSync, renameSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { ArchiveAction } from '../types';

export interface ExecutionResult {
  /** 是否成功执行 */
  success: boolean;
  /** 是否因风险等级被跳过 */
  skipped: boolean;
  /** 最终文件路径 */
  finalPath?: string;
  /** 错误信息 */
  error?: string;
}

export interface ArchiveExecutorOptions {
  /** 项目根目录，用于校验目标路径不越界 */
  projectRoot: string;
  /** 自动执行的风险等级，默认 low */
  autoRiskLevels?: ArchiveAction['risk'][];
}

/**
 * 归档执行器：执行低风险的归档动作
 */
export class ArchiveExecutor {
  private autoRiskLevels: Set<ArchiveAction['risk']>;

  constructor(private options: ArchiveExecutorOptions) {
    this.autoRiskLevels = new Set(options.autoRiskLevels ?? ['low']);
  }

  async execute(action: ArchiveAction): Promise<ExecutionResult> {
    if (!this.autoRiskLevels.has(action.risk)) {
      return { success: false, skipped: true };
    }

    try {
      switch (action.type) {
        case 'move':
        case 'create':
          return this.executeMove(action);
        case 'ignore':
          return { success: true, skipped: false, finalPath: action.sourcePath };
        case 'merge':
        case 'flag':
        default:
          // merge/flag 默认不自动执行，等待人工确认
          return { success: false, skipped: true };
      }
    } catch (err) {
      return {
        success: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private executeMove(action: ArchiveAction): ExecutionResult {
    const target = action.targetPath;
    if (!target) {
      return { success: false, skipped: false, error: '缺少 targetPath' };
    }

    // 安全校验：目标路径必须在项目根目录下
    const rel = relative(this.options.projectRoot, target);
    if (rel.startsWith('..') || rel === target) {
      return { success: false, skipped: false, error: '目标路径越界' };
    }

    mkdirSync(dirname(target), { recursive: true });
    renameSync(action.sourcePath, target);
    return { success: true, skipped: false, finalPath: target };
  }
}
