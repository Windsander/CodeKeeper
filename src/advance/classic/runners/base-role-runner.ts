import { schedule, validate as validateCron } from 'node-cron';
import { existsSync } from 'node:fs';
import { LlmClient } from '../../llm/client.js';
import type { Project, GitlabConfig, RoleConfig, Role } from '../../types.js';
import { getArchiveRoot } from '../../types.js';
import { loadSoulContent, type SoulContent } from '../soul/soul-loader.js';
import { loadProjectContext } from '../context/project-context-loader.js';
import {
  recordProjectError,
  clearProjectError,
  recordProjectMissingToken,
  recordAgentStarted,
} from '../status/project-status-store.js';
import type { ProjectConfig, IRoleRunner } from './role-runner.js';

export interface BaseRoleRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
}

/**
 * 角色 Runner 抽象基类
 *
 * 统一约束所有角色 Runner 的公共生命周期：
 * - 启动/停止项目循环
 * - cron 调度
 * - 运行锁（前一次未完成则跳过）
 * - GitLab Token / 本地目录预检查
 * - 项目错误状态记录
 *
 * 子类只需实现 runProject() 方法，专注于业务逻辑。
 */
export abstract class BaseRoleRunner implements IRoleRunner {
  protected readonly llmClient: LlmClient;
  private activeLoops = new Map<string, ReturnType<typeof schedule>>();
  private runningProjects = new Set<string>();

  constructor(options: BaseRoleRunnerOptions) {
    this.llmClient = options.llmClient;
  }

  /**
   * 当前 Runner 处理的角色标识
   */
  protected abstract getRole(): Role;

  /**
   * 默认的 cron 调度表达式
   */
  protected abstract getDefaultSchedule(): string;

  /**
   * 启动指定项目的角色循环
   */
  async startProjectLoop(project: ProjectConfig): Promise<void> {
    const fullProject = project as unknown as Project;
    const config = this.getRoleConfig(fullProject);

    if (!config?.enabled) {
      console.log(`[${this.getRoleName()}] 项目 ${fullProject.name} 未启用，跳过`);
      return;
    }

    const scheduleExpr = config.reviewSchedule?.trim() || this.getDefaultSchedule();
    if (!validateCron(scheduleExpr)) {
      const message = `[${this.getRoleName()}] 项目 ${fullProject.name} 的 reviewSchedule "${scheduleExpr}" 不是合法的 cron 表达式`;
      console.error(message);
      recordProjectError(fullProject, new Error(message), 'unknown');
      return;
    }

    recordAgentStarted(fullProject);

    // 立即执行一次
    await this.runOnce(fullProject);

    // 按 schedule 定时执行，若前一次未完成则跳过
    const job = schedule(scheduleExpr, () => {
      void this.runOnce(fullProject);
    });

    this.activeLoops.set(fullProject.id, job);
    console.log(`[${this.getRoleName()}] 项目 ${fullProject.name} 已启动定时循环: ${scheduleExpr}`);
  }

  /**
   * 停止指定项目的角色循环
   */
  stopProjectLoop(projectId: string): void {
    const job = this.activeLoops.get(projectId);
    if (job) {
      job.stop();
      this.activeLoops.delete(projectId);
      console.log(`[${this.getRoleName()}] 项目 ${projectId} 定时循环已停止`);
    }
  }

  /**
   * 执行单次循环；若前一次仍在运行则跳过
   */
  private async runOnce(project: Project): Promise<void> {
    if (this.runningProjects.has(project.id)) {
      console.log(`[${this.getRoleName()}] 项目 ${project.name} 的上一次循环尚未完成，跳过本次调度`);
      return;
    }
    this.runningProjects.add(project.id);
    try {
      await this.runProjectSafely(project);
    } finally {
      this.runningProjects.delete(project.id);
    }
  }

  /**
   * 安全地执行项目循环，捕获异常避免崩溃
   */
  private async runProjectSafely(project: Project): Promise<void> {
    try {
      if (!this.validatePrerequisites(project)) {
        return;
      }

      const config = this.getRoleConfig(project);
      if (!config?.enabled) {
        console.log(`[${this.getRoleName()}] 项目 ${project.name} 未启用，跳过`);
        return;
      }

      await this.runProject(project, config);
      clearProjectError(project);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${this.getRoleName()}] 项目 ${project.name} 循环异常: ${message}`);
      recordProjectError(project, error);
    }
  }

  /**
   * 子类实现：执行角色专属的业务逻辑
   */
  protected abstract runProject(project: Project, config: RoleConfig): Promise<void>;

  /**
   * 获取当前角色配置
   */
  protected getRoleConfig(project: Project): RoleConfig | undefined {
    return project.roles?.[this.getRole()];
  }

  /**
   * 统一加载当前角色的 soulContent 和 projectContext
   */
  protected loadRoleContext(project: Project): { soul: SoulContent; projectContext: string } {
    const soul = loadSoulContent(project, this.getRole());
    const projectContext = loadProjectContext(getArchiveRoot(project));
    return { soul, projectContext };
  }

  /**
   * 前置校验：GitLab 配置、Token、本地目录
   */
  protected validatePrerequisites(project: Project): boolean {
    if (!project.gitlab) {
      console.log(`[${this.getRoleName()}] 项目 ${project.name} 未配置 GitLab，跳过`);
      return false;
    }

    const config = this.getRoleConfig(project);
    if (!config?.enabled) {
      console.log(`[${this.getRoleName()}] 项目 ${project.name} 未启用，跳过`);
      return false;
    }

    const gitlabConfig: GitlabConfig = project.gitlab;

    if (!gitlabConfig.token || gitlabConfig.token.trim() === '') {
      const message = `[${this.getRoleName()}] 项目 ${project.name} 未配置 GitLab Access Token`;
      console.error(message);
      recordProjectMissingToken(project, message);
      return false;
    }

    if (!existsSync(project.rootPath)) {
      const message = `[${this.getRoleName()}] 项目 ${project.name} 的本地目录不存在，跳过`;
      console.warn(message);
      recordProjectError(project, new Error(message), 'unknown');
      return false;
    }

    return true;
  }

  private getRoleName(): string {
    const role = this.getRole();
    return role.charAt(0).toUpperCase() + role.slice(1);
  }
}
