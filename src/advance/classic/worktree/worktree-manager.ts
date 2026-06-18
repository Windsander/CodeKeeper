import simpleGit, { type SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../../core/logger.js';

const execFileAsync = promisify(execFile);

export interface WorktreeManagerOptions {
  /** 项目唯一标识 */
  projectId: string;
  /** 原项目根目录 */
  rootPath: string;
  /** Git 远程仓库地址 */
  remoteUrl: string;
  /** 用于测试注入的 SimpleGit 实例 */
  git?: SimpleGit;
  /** 用于测试注入的脚本运行器 */
  runScript?: (script: string, cwd: string) => Promise<{ success: boolean }>;
}

async function defaultRunScript(script: string, cwd: string): Promise<{ success: boolean }> {
  try {
    await execFileAsync('npm', ['run', script], { cwd });
    return { success: true };
  } catch (err) {
    logger.warn({ err, script }, `运行 ${script} 失败`);
    return { success: false };
  }
}

/**
 * WorktreeManager
 *
 * 管理每个项目独立的隔离工作区，用于 MR 自动修复时的代码修改。
 * 工作区路径为 `{rootPath}/../.codekeeper-worktree/{projectId}/`。
 */
export class WorktreeManager {
  private readonly worktreePath: string;
  private readonly git: SimpleGit;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.worktreePath = this.resolveWorktreePath();
    this.git = options.git ?? simpleGit(this.worktreePath);
  }

  /** 获取工作区绝对路径 */
  getWorktreePath(): string {
    return this.worktreePath;
  }

  private resolveWorktreePath(): string {
    const parent = dirname(this.options.rootPath);
    return resolve(parent, '.codekeeper-worktree', this.options.projectId);
  }

  /**
   * 确保工作区存在
   *
   * 首次调用时从 remoteUrl clone；已存在则执行 fetch 更新。
   */
  async ensureWorktree(): Promise<void> {
    const exists = existsSync(this.worktreePath);
    if (!exists) {
      mkdirSync(dirname(this.worktreePath), { recursive: true });
      logger.info(
        { projectId: this.options.projectId, worktreePath: this.worktreePath },
        '创建 worktree'
      );
      await simpleGit().clone(this.options.remoteUrl, this.worktreePath, [
        '--origin',
        'origin',
      ]);
      return;
    }

    logger.info({ projectId: this.options.projectId }, '更新 worktree');
    await this.git.fetch('origin');
  }

  /**
   * 基于源分支切出修复分支
   *
   * 分支名格式为 `codekeeper-fix/{sourceBranch}-{timestamp}`。
   */
  async createFixBranch(sourceBranch: string): Promise<string> {
    await this.git.fetch('origin', sourceBranch);
    const timestamp = Date.now();
    const branchName = `codekeeper-fix/${sourceBranch}-${timestamp}`;
    await this.git.checkoutBranch(branchName, `origin/${sourceBranch}`);
    return branchName;
  }

  /** 读取工作区内的相对路径文件 */
  readFile(relPath: string): string {
    return readFileSync(join(this.worktreePath, relPath), 'utf-8');
  }

  /** 写入工作区内的相对路径文件 */
  writeFile(relPath: string, content: string): void {
    const targetPath = join(this.worktreePath, relPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content, 'utf-8');
  }

  /**
   * 提交并推送当前变更
   *
   * 若无变更则跳过提交。
   */
  async commitAndPush(branchName: string, message: string): Promise<void> {
    await this.git.add('.');
    const status = await this.git.status();
    if (status.files.length === 0) {
      logger.info({ branchName }, 'worktree 无变更，跳过提交');
      return;
    }
    await this.git.commit(message);
    await this.git.push('origin', branchName, ['--set-upstream']);
  }

  /** 强制删除本地分支 */
  async cleanupBranch(branchName: string): Promise<void> {
    try {
      await this.git.deleteLocalBranch(branchName, true);
    } catch (err) {
      logger.warn({ err, branchName }, '清理本地分支失败');
    }
  }

  /**
   * 运行 lint 与 typecheck 校验
   *
   * 返回两项校验是否分别通过。
   */
  async validate(): Promise<{ lint: boolean; typecheck: boolean }> {
    const runner = this.options.runScript ?? defaultRunScript;

    const [lint, typecheck] = await Promise.all([
      runner('lint', this.worktreePath),
      runner('typecheck', this.worktreePath),
    ]);
    return { lint: lint.success, typecheck: typecheck.success };
  }
}
