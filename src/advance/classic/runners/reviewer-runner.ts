/**
 * Reviewer 角色的 Runner 实现
 *
 * 负责：拉取 MR、执行代码评审、发布 summary comment。
 * 不处理 discussion 创建、auto-fix 或 resolve。
 */

import { schedule, validate as validateCron } from 'node-cron';
import { LlmClient } from '../../llm/client.js';
import { GitLabProvider } from '../provider/gitlab-provider.js';
import { ClassicReviewer } from '../review/reviewer.js';
import { loadSoulContent } from '../soul/soul-loader.js';
import { loadProjectContext } from '../context/project-context-loader.js';
import {
  recordProjectError,
  clearProjectError,
  recordProjectMissingToken,
  recordAgentStarted,
} from '../status/project-status-store.js';
import type { Project, GitlabConfig } from '../../types.js';
import { getArchiveRoot } from '../../types.js';
import type { MergeRequest, MrDiff } from '../provider/types.js';
import { formatReviewComment } from './shared/review-utils.js';
import { getMrReviewConfig } from './shared/config-utils.js';
import type { ProjectConfig } from './role-runner.js';
import type { IRoleRunner } from './role-runner.js';

/**
 * ReviewerRunner 构造选项
 */
export interface ReviewerRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
}

export class ReviewerRunner implements IRoleRunner {
  private llmClient: LlmClient;
  private activeLoops = new Map<string, ReturnType<typeof schedule>>();

  constructor(options: ReviewerRunnerOptions) {
    this.llmClient = options.llmClient;
  }

  async startProjectLoop(project: ProjectConfig): Promise<void> {
    const fullProject = project as unknown as Project;
    const config = getMrReviewConfig(fullProject);

    if (!config.enabled) {
      console.log(`[ReviewerRunner] 项目 ${fullProject.name} 未启用 MR 评审，跳过`);
      return;
    }

    const scheduleExpr = config.reviewSchedule?.trim() || '*/10 * * * *';
    if (!validateCron(scheduleExpr)) {
      const message = `[ReviewerRunner] 项目 ${fullProject.name} 的 reviewSchedule "${scheduleExpr}" 不是合法的 cron 表达式`;
      console.error(message);
      recordProjectError(fullProject, new Error(message), 'unknown');
      return;
    }

    recordAgentStarted(fullProject);

    // 立即执行一次评审
    await this.reviewProjectSafely(fullProject);

    // 按 schedule 定时执行
    const job = schedule(scheduleExpr, () => {
      void this.reviewProjectSafely(fullProject);
    });

    this.activeLoops.set(fullProject.id, job);
    console.log(`[ReviewerRunner] 项目 ${fullProject.name} 已启动定时评审循环: ${scheduleExpr}`);
  }

  stopProjectLoop(projectId: string): void {
    const job = this.activeLoops.get(projectId);
    if (job) {
      job.stop();
      this.activeLoops.delete(projectId);
      console.log(`[ReviewerRunner] 项目 ${projectId} 定时评审循环已停止`);
    }
  }

  /**
   * 安全地执行项目评审，捕获异常避免崩溃
   */
  private async reviewProjectSafely(project: Project): Promise<void> {
    try {
      await this.reviewProject(project);
      clearProjectError(project);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerRunner] 项目 ${project.name} 评审异常: ${message}`);
      recordProjectError(project, error);
    }
  }

  /**
   * 对单个项目执行 MR 评审轮询
   *
   * 流程：
   * 1. 构造 GitLabProvider
   * 2. 列出所有 open MRs
   * 3. 跳过 draft MR
   * 4. 对每个非 draft MR 获取 diff 和 SHA 信息
   * 5. 调用 ClassicReviewer.review() 生成 findings
   * 6. 发布 summary comment
   */
  private async reviewProject(project: Project): Promise<void> {
    if (!project.gitlab) {
      console.log(`[ReviewerRunner] 项目 ${project.name} 未配置 GitLab，跳过`);
      return;
    }

    const config = getMrReviewConfig(project);
    if (!config.enabled) {
      console.log(`[ReviewerRunner] 项目 ${project.name} 未启用 MR 评审，跳过`);
      return;
    }

    const gitlabConfig: GitlabConfig = project.gitlab;

    // Token 预检查：缺失时直接记录错误，不再继续调用 API
    if (!gitlabConfig.token || gitlabConfig.token.trim() === '') {
      const message = `[ReviewerRunner] 项目 ${project.name} 未配置 GitLab Access Token`;
      console.error(message);
      recordProjectMissingToken(project, message);
      return;
    }

    const provider = new GitLabProvider(gitlabConfig);

    const soul = loadSoulContent(project, 'reviewer');
    const projectContext = loadProjectContext(getArchiveRoot(project));

    const reviewer = new ClassicReviewer({
      client: this.llmClient,
      tokenBudget: 4000,
      rules: soul.content || '默认评审规则：检查代码质量、安全性、性能问题',
      soulContent: soul.content || undefined,
      projectContext,
    });

    console.log(`[ReviewerRunner] 扫描项目 ${project.name} 的 open MRs...`);

    let mrs: MergeRequest[];
    try {
      mrs = await provider.listOpenMRs(config.filter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerRunner] 列出项目 ${project.name} 的 MR 失败: ${message}`);
      recordProjectError(project, error);
      return;
    }

    console.log(`[ReviewerRunner] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);

    for (const mr of mrs) {
      if (mr.draft) {
        console.log(`[ReviewerRunner] 跳过 draft MR !${mr.iid}: ${mr.title}`);
        continue;
      }

      console.log(`[ReviewerRunner] 评审 MR !${mr.iid}: ${mr.title}`);

      let diffs: MrDiff[];
      try {
        diffs = await provider.getMRDiff(mr.iid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] 获取 MR !${mr.iid} diff 失败: ${message}`);
        continue;
      }

      if (diffs.length === 0) {
        console.log(`[ReviewerRunner] MR !${mr.iid} 无变更，跳过`);
        continue;
      }

      let result;
      try {
        result = await reviewer.review(mr, diffs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] 评审 MR !${mr.iid} 失败: ${message}`);
        continue;
      }

      if (result.findings.length === 0) {
        console.log(`[ReviewerRunner] MR !${mr.iid} 无发现问题`);
        continue;
      }

      // 发布 summary comment
      const comment = formatReviewComment(mr, result);
      try {
        await provider.postReviewComment(mr.iid, comment);
        console.log(`[ReviewerRunner] 已在 MR !${mr.iid} 发表 summary 评论`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] 在 MR !${mr.iid} 发表 summary 评论失败: ${message}`);
      }
    }
  }
}
