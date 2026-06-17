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

  async undo(actionId: string): Promise<UndoResult> {
    const history = this.options.store.getActionHistory(actionId);
    if (!history) {
      return { success: false, message: '未找到动作历史记录' };
    }
    if (history.status === 'undone') {
      return { success: false, message: '该动作已被撤销' };
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
        const previous = this.options.store.getArchiveMetadata(history.id)?.archivePath;
        if (previous && existsSync(history.targetPath)) {
          renameSync(history.targetPath, previous);
        }
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
