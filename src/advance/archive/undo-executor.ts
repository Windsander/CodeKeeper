import { renameSync, existsSync, rmSync } from 'node:fs';
import type { MetadataStore } from '../store/metadata-store';

export interface UndoResult {
  success: boolean;
  message: string;
}

/**
 * 归档动作撤销器：根据 action_history 恢复已执行的动作
 */
export class UndoExecutor {
  constructor(private options: { store: MetadataStore; projectRoot: string }) {}

  async undo(actionId: string): Promise<UndoResult> {
    const history = this.options.store.getActionHistory(actionId);
    if (!history) {
      return { success: false, message: '未找到动作历史记录' };
    }
    if (history.status === 'undone') {
      return { success: false, message: '该动作已被撤销' };
    }

    switch (history.type) {
      case 'move': {
        if (!history.targetPath) {
          return { success: false, message: 'move 动作缺少目标路径' };
        }
        if (!existsSync(history.targetPath)) {
          return { success: false, message: `目标文件已不存在：${history.targetPath}` };
        }
        if (existsSync(history.sourcePath)) {
          return { success: false, message: `源路径已存在其他文件：${history.sourcePath}` };
        }
        renameSync(history.targetPath, history.sourcePath);
        this.restoreEntry(history.projectId, history.targetPath, history.sourcePath);
        break;
      }
      case 'create': {
        if (!history.targetPath) {
          return { success: false, message: 'create 动作缺少目标路径' };
        }
        if (existsSync(history.targetPath)) {
          rmSync(history.targetPath);
        }
        this.restoreEntry(history.projectId, history.targetPath);
        break;
      }
      case 'ignore': {
        this.restoreEntry(history.projectId, history.sourcePath);
        break;
      }
      default:
        return { success: false, message: `暂不支持的撤销类型：${history.type}` };
    }

    this.options.store.markHistoryUndone(history.historyId);
    return { success: true, message: '撤销成功' };
  }

  private restoreEntry(projectId: string, currentFilePath: string, newFilePath?: string): void {
    const entries = this.options.store.listEntriesByProject(projectId);
    const existing = entries.find((e) => e.filePath === currentFilePath);
    if (existing) {
      this.options.store.upsertEntry({
        ...existing,
        filePath: newFilePath ?? currentFilePath,
        status: 'pending',
        updatedAt: Date.now(),
      });
    }
  }
}
