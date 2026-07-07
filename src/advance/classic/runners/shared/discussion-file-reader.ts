import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeManager } from '../../worktree/worktree-manager.js';

/**
 * 读取 discussion 关联文件的内容。
 * 优先从 worktree 读取（确保拿到 MR 分支最新文件），失败则回退原项目目录。
 */
export async function readDiscussionFileContent(
  worktreeManager: WorktreeManager,
  rootPath: string,
  filePath: string,
  sourceBranch: string
): Promise<string | null> {
  try {
    await worktreeManager.ensureWorktree();
    await worktreeManager.checkoutBranch(sourceBranch);
    return worktreeManager.readFile(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[MaintainerRunner] 从 worktree 读取 ${filePath} 失败: ${message}`);
  }

  try {
    const content = readFileSync(join(rootPath, filePath), 'utf-8');
    console.log(`[MaintainerRunner] 已从项目根目录兜底读取 ${filePath}`);
    return content;
  } catch (fallbackErr) {
    const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    console.warn(`[MaintainerRunner] 从项目根目录兜底读取 ${filePath} 也失败: ${message}`);
  }

  return null;
}
