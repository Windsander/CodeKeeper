import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeManager } from '../../worktree/worktree-manager.js';
import type { FocusedContext } from '../../fix/focused-context-builder.js';
import { buildFocusedContext } from '../../fix/focused-context-builder.js';
import { buildFocusedContextStreamed } from '../../fix/focused-context-streamer.js';
import type { ReviewFinding } from '../../provider/types.js';

/**
 * 读取 discussion 关联文件的聚焦上下文。
 * 优先从 worktree 读取（确保拿到 MR 分支最新文件），失败则回退原项目目录。
 */
export async function readDiscussionFileContent(
  worktreeManager: WorktreeManager,
  rootPath: string,
  finding: ReviewFinding,
  sourceBranch: string
): Promise<FocusedContext | null> {
  const filePath = finding.file;

  try {
    console.log(`[readDiscussionFileContent] 阶段=ensure 准备 worktree`);
    await worktreeManager.ensureWorktree();
    console.log(`[readDiscussionFileContent] 阶段=checkout 切换到 ${sourceBranch}`);
    await worktreeManager.checkoutBranch(sourceBranch);

    console.log(`[readDiscussionFileContent] 阶段=resolve 解析 ${filePath}`);
    const resolvedPath = await worktreeManager.resolveFilePath(filePath);
    if (!resolvedPath) {
      console.warn(`[MaintainerRunner] 无法在 worktree 中定位 ${filePath}`);
      return null;
    }
    if (resolvedPath !== filePath) {
      console.log(`[readDiscussionFileContent] 解析结果: ${filePath} -> ${resolvedPath}`);
    }

    console.log(`[readDiscussionFileContent] 阶段=readWindow 读取 ${resolvedPath}:${finding.line}`);
    return await worktreeManager.readFileWindow(resolvedPath, finding);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[MaintainerRunner] 从 worktree 读取 ${filePath} 失败: ${message}`);
  }

  try {
    const fullPath = join(rootPath, filePath);
    const content = readFileSync(fullPath, 'utf-8');
    console.log(`[MaintainerRunner] 已从项目根目录兜底读取 ${filePath}`);
    return buildFocusedContext(content, finding);
  } catch (fallbackErr) {
    const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    console.warn(`[MaintainerRunner] 从项目根目录兜底读取 ${filePath} 也失败: ${message}`);
  }

  return null;
}

/**
 * 读取 discussion 关联文件完整内容（保留给明确需要全文件的场景）。
 * 超过 512KB 会抛出 WorktreeError。
 */
export async function readDiscussionFullFile(
  worktreeManager: WorktreeManager,
  rootPath: string,
  filePath: string,
  sourceBranch: string
): Promise<string | null> {
  try {
    await worktreeManager.ensureWorktree();
    await worktreeManager.checkoutBranch(sourceBranch);
    const resolvedPath = await worktreeManager.resolveFilePath(filePath);
    if (!resolvedPath) {
      console.warn(`[MaintainerRunner] 无法在 worktree 中定位 ${filePath}`);
      return null;
    }
    return worktreeManager.readFile(resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[MaintainerRunner] 从 worktree 全读 ${filePath} 失败: ${message}`);
  }

  try {
    return readFileSync(join(rootPath, filePath), 'utf-8');
  } catch (fallbackErr) {
    const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    console.warn(`[MaintainerRunner] 从项目根目录兜底全读 ${filePath} 也失败: ${message}`);
  }

  return null;
}

/**
 * 从任意绝对路径流式构建聚焦上下文（用于本地兜底）
 */
export async function buildFocusedContextFromPath(
  filePath: string,
  finding: ReviewFinding
): Promise<FocusedContext> {
  return buildFocusedContextStreamed(filePath, finding);
}
