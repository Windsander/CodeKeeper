import { existsSync, renameSync, rmSync } from 'node:fs';
import type { MetadataStore } from '../store/metadata-store';

export interface UndoResult {
  success: boolean;
  message: string;
}

/**
 * 归档动作撤销器：根据 action_history 恢复已执行的动作
 */
export class UndoExecutor {
  constructor(private options: { store: MetadataStore }) {}

  async undo(actionId: string, projectId?: string): Promise<UndoResult> {
    const history = this.options.store.getActionHistory(actionId);
    if (!history) {
      return { success: false, message: '未找到动作历史记录' };
    }
    if (history.status === 'undone') {
      return { success: false, message: '该动作已被撤销' };
    }
    if (projectId && history.projectId !== projectId) {
      return { success: false, message: '动作不属于当前项目' };
    }

    switch (history.type) {
      case 'copy':
      case 'flag': {
        if (history.targetPath && existsSync(history.targetPath)) {
          rmSync(history.targetPath);
        }
        break;
      }
      case 'organize': {
        if (!history.targetPath) {
          return { success: false, message: 'organize 动作缺少目标路径' };
        }
        // action_history.source_path 是 organize 前的原位置，target_path 是新位置。
        // 不能用 action id 查询 archive_metadata：metadata.entry_id 使用的是源文件路径。
        if (!existsSync(history.targetPath)) {
          return { success: false, message: 'organize 目标文件不存在，无法恢复原位置' };
        }
        renameSync(history.targetPath, history.sourcePath);
        break;
      }
      case 'ignore': {
        // 无需文件系统操作
        break;
      }
      default:
        return { success: false, message: `暂不支持的撤销类型：${history.type}` };
    }

    this.options.store.markHistoryUndone(history.historyId);
    return { success: true, message: '撤销成功' };
  }
}
