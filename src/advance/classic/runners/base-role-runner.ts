import { existsSync } from 'node:fs';
import { LlmClient } from '../../llm/client.js';
import type { Project, GitlabConfig, RoleConfig, Role } from '../../types.js';
import { getArchiveRoot, isRoleConfigEnabled } from '../../types.js';
import { loadSoulContent, type SoulContent } from '../soul/soul-loader.js';
import { loadProjectContext } from '../context/project-context-loader.js';
import {
  recordProjectError,
  clearProjectError,
  recordProjectMissingToken,
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
 * - 单次项目执行（runProjectOnce），含运行锁（重入跳过）
 * - GitLab Token / 本地目录预检查
 * - 项目错误状态记录
 *
 * 调度由 daemon 侧 PipelineScheduler 负责（管线 trigger.cron 节点），
 * Runner 不再自持 cron 循环。
 */
export abstract class BaseRoleRunner implements IRoleRunner {
  protected readonly llmClient: LlmClient;
  private runningProjects = new Set<string>();

  constructor(options: BaseRoleRunnerOptions) {
    this.llmClient = options.llmClient;
  }

  /**
   * 当前 Runner 处理的角色标识
   */
  protected abstract getRole(): Role;

  /**
   * 执行单次项目循环；若该项目前一次仍在运行则跳过（运行锁）
   */
  async runProjectOnce(project: ProjectConfig): Promise<void> {
    const fullProject = project as unknown as Project;
    if (this.runningProjects.has(fullProject.id)) {
      console.log(
        `[${this.getRoleName()}] 项目 ${fullProject.name} 的上一次循环尚未完成，跳过本次调度`
      );
      return;
    }
    this.runningProjects.add(fullProject.id);
    try {
      await this.runProjectSafely(fullProject);
    } finally {
      this.runningProjects.delete(fullProject.id);
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
      if (!config || !isRoleConfigEnabled(config)) {
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
    if (!isRoleConfigEnabled(config)) {
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
