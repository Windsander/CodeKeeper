import simpleGit, { type SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../../core/logger.js';

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  constructor(
    public readonly stage: string,
    cause?: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause ?? '');
    super(`Worktree ${stage} 失败: ${message}`);
  }
}

export interface RunScriptResult {
  success: boolean;
  reason?: string;
}

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
  runScript?: (script: string, cwd: string) => Promise<RunScriptResult>;
  /** 用于测试注入的依赖安装器 */
  install?: (cwd: string) => Promise<RunScriptResult>;
  /** 提交使用的 git 用户名 */
  gitUserName?: string;
  /** 提交使用的 git 邮箱 */
  gitUserEmail?: string;
}

async function defaultRunScript(script: string, cwd: string): Promise<RunScriptResult> {
  try {
    // Windows 上 npm 是 .cmd 脚本，execFile 直接执行需要 shell 支持
    await execFileAsync('npm', ['run', script], {
      cwd,
      shell: process.platform === 'win32',
    });
    return { success: true };
  } catch (err) {
    logger.warn({ err, script }, `运行 ${script} 失败`);
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, reason };
  }
}

async function defaultInstall(cwd: string): Promise<RunScriptResult> {
  try {
    logger.info({ cwd }, 'worktree 安装依赖');
    await execFileAsync('npm', ['install'], {
      cwd,
      shell: process.platform === 'win32',
    });
    return { success: true };
  } catch (err) {
    logger.warn({ err }, 'worktree 安装依赖失败');
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, reason };
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
  private git?: SimpleGit;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.worktreePath = this.resolveWorktreePath();
  }

  /** 获取或创建 SimpleGit 实例（懒加载，确保 worktree 目录已存在） */
  private getGit(): SimpleGit {
    if (!this.git) {
      this.git = this.options.git ?? simpleGit(this.worktreePath);
    }
    return this.git;
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
      try {
        await simpleGit().clone(this.options.remoteUrl, this.worktreePath, [
          '--origin',
          'origin',
        ]);
      } catch (err) {
        throw new WorktreeError('clone', err);
      }
      await this.ensureGitConfig();
      return;
    }

    logger.info({ projectId: this.options.projectId }, '更新 worktree');
    // 同步远程 URL，确保 token 更新后也能正常 fetch/push
    try {
      await this.getGit().remote(['set-url', 'origin', this.options.remoteUrl]);
    } catch (err) {
      logger.warn({ err, projectId: this.options.projectId }, '更新 worktree remote URL 失败');
    }
    try {
      await this.getGit().fetch('origin');
    } catch (err) {
      throw new WorktreeError('fetch', err);
    }
    await this.ensureGitConfig();
  }

  /**
   * 确保 worktree 中 git 用户配置存在，避免 commit 失败
   */
  private async ensureGitConfig(): Promise<void> {
    const git = this.getGit();
    const [name, email] = await Promise.all([
      git.getConfig('user.name'),
      git.getConfig('user.email'),
    ]);
    if (!name.value) {
      await git.addConfig(
        'user.name',
        this.options.gitUserName ?? 'CodeKeeper Maintainer',
        false,
        'local'
      );
    }
    if (!email.value) {
      await git.addConfig(
        'user.email',
        this.options.gitUserEmail ?? 'maintainer@codekeeper.local',
        false,
        'local'
      );
    }
  }

  /**
   * 准备运行环境：安装 node_modules 等依赖
   */
  async prepareEnvironment(): Promise<void> {
    const packageJsonPath = join(this.worktreePath, 'package.json');
    const nodeModulesPath = join(this.worktreePath, 'node_modules');
    if (!existsSync(packageJsonPath)) {
      logger.info({ worktreePath: this.worktreePath }, 'worktree 无 package.json，跳过环境准备');
      return;
    }
    if (existsSync(nodeModulesPath)) {
      const nodeModulesStat = statSync(nodeModulesPath);
      const packageJsonStat = statSync(packageJsonPath);
      if (nodeModulesStat.mtime >= packageJsonStat.mtime) {
        logger.info({ worktreePath: this.worktreePath }, 'worktree 依赖已是最新，跳过安装');
        return;
      }
    }

    logger.info({ worktreePath: this.worktreePath }, 'worktree 准备运行环境');
    const installer = this.options.install ?? defaultInstall;
    const result = await installer(this.worktreePath);
    if (!result.success) {
      throw new WorktreeError('install', result.reason ?? '安装依赖失败');
    }
  }

  /**
   * 基于源分支切出修复分支
   *
   * 分支名格式为 `codekeeper-fix/{sourceBranch}-{timestamp}`。
   */
  async createFixBranch(sourceBranch: string): Promise<string> {
    await this.getGit().fetch('origin', sourceBranch);
    const timestamp = Date.now();
    const branchName = `codekeeper-fix/${sourceBranch}-${timestamp}`;
    await this.getGit().checkoutBranch(branchName, `origin/${sourceBranch}`);
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
   * 切换到指定分支（通常是 MR 的 source branch）
   *
   * 先丢弃本地变更、清理未跟踪文件、拉取最新状态，再 checkout。
   */
  async checkoutBranch(branchName: string): Promise<void> {
    try {
      logger.info({ projectId: this.options.projectId, branchName }, 'worktree 切换分支');
      await this.getGit().fetch('origin', branchName);
      // 丢弃之前未完成的修复变更，确保分支干净
      await this.getGit().reset(['--hard']);
      await this.getGit().clean(['-fd']);
      await this.getGit().checkout(['-B', branchName, `origin/${branchName}`]);
    } catch (err) {
      throw new WorktreeError('checkout', err);
    }
  }

  /**
   * 提交并推送当前变更
   *
   * 若无变更则跳过提交。
   */
  async commitAndPush(
    branchName: string,
    message: string,
    options?: { setUpstream?: boolean }
  ): Promise<void> {
    await this.getGit().add('.');
    const status = await this.getGit().status();
    if (status.files.length === 0) {
      logger.info({ branchName }, 'worktree 无变更，跳过提交');
      return;
    }
    try {
      await this.getGit().commit(message);
    } catch (err) {
      throw new WorktreeError('commit', err);
    }
    try {
      if (options?.setUpstream ?? true) {
        await this.getGit().push('origin', branchName, ['--set-upstream']);
      } else {
        await this.getGit().push('origin', branchName);
      }
    } catch (err) {
      throw new WorktreeError('push', err);
    }
  }

  /** 强制删除本地分支 */
  async cleanupBranch(branchName: string): Promise<void> {
    try {
      await this.getGit().deleteLocalBranch(branchName, true);
    } catch (err) {
      logger.warn({ err, branchName }, '清理本地分支失败');
    }
  }

  /**
   * 运行 lint 与 typecheck 校验
   *
   * 返回两项校验是否分别通过。
   */
  async validate(): Promise<{ lint: boolean; typecheck: boolean; lintReason?: string; typecheckReason?: string }> {
    const runner = this.options.runScript ?? defaultRunScript;

    const [lint, typecheck] = await Promise.all([
      runner('lint', this.worktreePath),
      runner('typecheck', this.worktreePath),
    ]);

    return {
      lint: lint.success,
      typecheck: typecheck.success,
      lintReason: lint.reason,
      typecheckReason: typecheck.reason,
    };
  }
}
