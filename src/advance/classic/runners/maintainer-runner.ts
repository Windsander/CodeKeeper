/**
 * Maintainer 角色的 Runner 实现
 *
 * 负责：创建 discussion、尝试自动修复、resolve discussion、处理他人 discussions。
 * 不发布 review summary。
 */

import { schedule, validate as validateCron } from 'node-cron';
import { LlmClient } from '../../llm/client.js';
import { GitLabProvider } from '../provider/gitlab-provider.js';
import { ClassicReviewer } from '../review/reviewer.js';
import { WorktreeManager } from '../worktree/worktree-manager.js';
import { MrFixAgent } from '../fix/mr-fix-agent.js';
import { FixDecisionEngine } from '../fix/fix-decision-engine.js';
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
import type { MergeRequest, MrDiff, ReviewFinding } from '../provider/types.js';
import { buildDiffPosition, getFindingKey } from '../provider/discussion-mapper.js';
import { formatFindingDiscussionBody } from './shared/review-utils.js';
import { getMrReviewConfig, buildRemoteUrl } from './shared/config-utils.js';
import { loadState, saveState, getDiscussionStateKey } from './shared/state-utils.js';
import { inferFindingFromDiscussion } from './shared/finding-utils.js';
import type { ProjectConfig } from './role-runner.js';
import type { IRoleRunner } from './role-runner.js';

/**
 * MaintainerRunner 构造选项
 */
export interface MaintainerRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
}

export class MaintainerRunner implements IRoleRunner {
  private llmClient: LlmClient;
  private activeLoops = new Map<string, ReturnType<typeof schedule>>();

  constructor(options: MaintainerRunnerOptions) {
    this.llmClient = options.llmClient;
  }

  async startProjectLoop(project: ProjectConfig): Promise<void> {
    const fullProject = project as unknown as Project;
    const config = getMrReviewConfig(fullProject);

    if (!config.enabled) {
      console.log(`[MaintainerRunner] 项目 ${fullProject.name} 未启用 MR 评审，跳过`);
      return;
    }

    const scheduleExpr = config.reviewSchedule?.trim() || '*/10 * * * *';
    if (!validateCron(scheduleExpr)) {
      const message = `[MaintainerRunner] 项目 ${fullProject.name} 的 reviewSchedule "${scheduleExpr}" 不是合法的 cron 表达式`;
      console.error(message);
      recordProjectError(fullProject, new Error(message), 'unknown');
      return;
    }

    recordAgentStarted(fullProject);

    // 立即执行一次
    await this.maintainProjectSafely(fullProject);

    // 按 schedule 定时执行
    const job = schedule(scheduleExpr, () => {
      void this.maintainProjectSafely(fullProject);
    });

    this.activeLoops.set(fullProject.id, job);
    console.log(`[MaintainerRunner] 项目 ${fullProject.name} 已启动定时维护循环: ${scheduleExpr}`);
  }

  stopProjectLoop(projectId: string): void {
    const job = this.activeLoops.get(projectId);
    if (job) {
      job.stop();
      this.activeLoops.delete(projectId);
      console.log(`[MaintainerRunner] 项目 ${projectId} 定时维护循环已停止`);
    }
  }

  /**
   * 安全地执行项目维护，捕获异常避免崩溃
   */
  private async maintainProjectSafely(project: Project): Promise<void> {
    try {
      await this.maintainProject(project);
      clearProjectError(project);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerRunner] 项目 ${project.name} 维护异常: ${message}`);
      recordProjectError(project, error);
    }
  }

  /**
   * 对单个项目执行 MR 维护轮询
   *
   * 流程：
   * 1. 构造 GitLabProvider
   * 2. 列出所有 open MRs
   * 3. 跳过 draft MR
   * 4. 对每个非 draft MR 获取 diff 和 SHA 信息
   * 5. 调用 ClassicReviewer.review() 生成 findings
   * 6. 仅对 HIGH/CRITICAL 创建 discussion thread（带代码行定位）
   * 7. 尝试自动修复并 resolve discussion
   * 8. 处理他人创建的 discussions
   */
  private async maintainProject(project: Project): Promise<void> {
    if (!project.gitlab) {
      console.log(`[MaintainerRunner] 项目 ${project.name} 未配置 GitLab，跳过`);
      return;
    }

    const config = getMrReviewConfig(project);
    if (!config.enabled) {
      console.log(`[MaintainerRunner] 项目 ${project.name} 未启用 MR 评审，跳过`);
      return;
    }

    const gitlabConfig: GitlabConfig = project.gitlab;

    // Token 预检查
    if (!gitlabConfig.token || gitlabConfig.token.trim() === '') {
      const message = `[MaintainerRunner] 项目 ${project.name} 未配置 GitLab Access Token`;
      console.error(message);
      recordProjectMissingToken(project, message);
      return;
    }

    const provider = new GitLabProvider(gitlabConfig);

    const soul = loadSoulContent(project, 'maintainer');
    const projectContext = loadProjectContext(getArchiveRoot(project));

    const reviewer = new ClassicReviewer({
      client: this.llmClient,
      tokenBudget: 4000,
      rules: soul.content || '默认维护规则：检查代码质量、安全性、性能问题并尝试自动修复',
      soulContent: soul.content || undefined,
      projectContext,
    });

    const state = loadState(project);

    // 构造 auto-fixer
    const autoFixEnabled = config.autoFixEnabled ?? true;
    const worktreeManager = new WorktreeManager({
      projectId: project.id,
      rootPath: project.rootPath,
      remoteUrl: buildRemoteUrl(gitlabConfig),
    });
    const fixAgent = new MrFixAgent({
      worktreeManager,
      reviewer,
      decisionEngine: new FixDecisionEngine(),
    });

    console.log(`[MaintainerRunner] 扫描项目 ${project.name} 的 open MRs...`);

    let mrs: MergeRequest[];
    try {
      mrs = await provider.listOpenMRs(config.filter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerRunner] 列出项目 ${project.name} 的 MR 失败: ${message}`);
      recordProjectError(project, error);
      return;
    }

    console.log(`[MaintainerRunner] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);

    for (const mr of mrs) {
      if (mr.draft) {
        console.log(`[MaintainerRunner] 跳过 draft MR !${mr.iid}: ${mr.title}`);
        continue;
      }

      console.log(`[MaintainerRunner] 维护 MR !${mr.iid}: ${mr.title}`);

      let diffs: MrDiff[];
      try {
        diffs = await provider.getMRDiff(mr.iid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerRunner] 获取 MR !${mr.iid} diff 失败: ${message}`);
        continue;
      }

      if (diffs.length === 0) {
        console.log(`[MaintainerRunner] MR !${mr.iid} 无变更，跳过`);
        continue;
      }

      let shaInfo;
      try {
        shaInfo = await provider.getMRShaInfo(mr.iid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerRunner] 获取 MR !${mr.iid} SHA 信息失败: ${message}`);
        continue;
      }

      let result;
      try {
        result = await reviewer.review(mr, diffs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerRunner] 评审 MR !${mr.iid} 失败: ${message}`);
        continue;
      }

      // 仅对 HIGH/CRITICAL 创建 discussion thread
      const stateKey = getDiscussionStateKey(mr);
      const postedDiscussions = state.discussions[stateKey] ?? [];
      const postedKeys = new Set(postedDiscussions.map((d) => d.findingKey));

      for (const finding of result.findings) {
        if (finding.severity !== 'HIGH' && finding.severity !== 'CRITICAL') {
          continue;
        }

        const key = getFindingKey(finding);
        if (postedKeys.has(key)) {
          console.log(`[MaintainerRunner] finding ${key} 已存在 discussion，跳过`);
          continue;
        }

        const position = buildDiffPosition(finding, diffs, shaInfo);
        if (!position) {
          console.warn(`[MaintainerRunner] 无法为 finding ${key} 构造 diff position，跳过`);
          continue;
        }

        const body = formatFindingDiscussionBody(finding);
        let discussionId: string;
        try {
          discussionId = await provider.createDiscussion(mr.iid, body, position);
          postedDiscussions.push({
            findingKey: key,
            discussionId,
            file: finding.file,
            line: finding.line,
            severity: finding.severity,
            resolved: false,
          });
          console.log(`[MaintainerRunner] 已为 finding ${key} 创建 discussion ${discussionId}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MaintainerRunner] 为 finding ${key} 创建 discussion 失败: ${message}`);
          continue;
        }

        // 自动修复并 resolve discussion
        if (autoFixEnabled) {
          const fixResult = await fixAgent.processFinding(finding, mr);
          if (fixResult.success) {
            try {
              await provider.resolveDiscussion(mr.iid, discussionId);
              const posted = postedDiscussions.find((d) => d.discussionId === discussionId);
              if (posted) posted.resolved = true;
              await provider.addDiscussionNote(
                mr.iid,
                discussionId,
                '✅ CodeKeeper 已自动修复该问题并推送至本分支。'
              );
              console.log(`[MaintainerRunner] 已修复 finding ${key} 并 resolve discussion ${discussionId}`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`[MaintainerRunner] resolve discussion ${discussionId} 失败: ${message}`);
            }
          } else if (fixResult.action === 'skip' || fixResult.action === 'defer') {
            try {
              await provider.addDiscussionNote(
                mr.iid,
                discussionId,
                `⏸️ CodeKeeper 决定暂不自动修复：${fixResult.reason}`
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`[MaintainerRunner] 在 discussion ${discussionId} 追加说明失败: ${message}`);
            }
          }
        }
      }

      state.discussions[stateKey] = postedDiscussions;
      saveState(project, state);

      // 处理他人 discussions
      if (config.resolveOthersDiscussions) {
        await this.handleOthersDiscussions(mr, provider, diffs, shaInfo, fixAgent);
      }
    }
  }

  /**
   * 处理他人 reviewer 创建的 discussions
   *
   * 对未 resolved 的 discussion：
   * - 尝试解析出 finding
   * - 能解析则尝试自动修复，成功后 resolve 并追加说明
   * - 不能解析或决定不修复则追加说明 comment，不 resolve
   */
  private async handleOthersDiscussions(
    mr: MergeRequest,
    provider: GitLabProvider,
    diffs: MrDiff[],
    shaInfo: { baseSha: string; headSha: string; startSha: string },
    fixAgent: MrFixAgent
  ): Promise<void> {
    let discussions;
    try {
      discussions = await provider.getDiscussions(mr.iid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerRunner] 获取 MR !${mr.iid} discussions 失败: ${message}`);
      return;
    }

    for (const discussion of discussions) {
      if (discussion.resolved || !discussion.resolvable) continue;

      const firstNote = discussion.notes[0];
      if (!firstNote) continue;

      // 跳过自己创建的 discussion（以 CodeKeeper 签名判断）
      if (firstNote.body.includes('CodeKeeper Advance MR 评审 Agent')) continue;

      const inferred = inferFindingFromDiscussion(firstNote.body);
      if (!inferred) {
        try {
          await provider.addDiscussionNote(
            mr.iid,
            discussion.id,
            '👋 CodeKeeper 无法自动解析该讨论，需要人工处理。'
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MaintainerRunner] 回复 discussion ${discussion.id} 失败: ${message}`);
        }
        continue;
      }

      const position = buildDiffPosition(inferred, diffs, shaInfo);
      if (!position) {
        try {
          await provider.addDiscussionNote(
            mr.iid,
            discussion.id,
            '👋 CodeKeeper 无法在当前 diff 中定位该问题，需要人工处理。'
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MaintainerRunner] 回复 discussion ${discussion.id} 失败: ${message}`);
        }
        continue;
      }

      const finding: ReviewFinding = { ...inferred, autoFixable: false };
      const fixResult = await fixAgent.processFinding(finding, mr);
      if (fixResult.success) {
        try {
          await provider.resolveDiscussion(mr.iid, discussion.id);
          await provider.addDiscussionNote(
            mr.iid,
            discussion.id,
            '✅ CodeKeeper 已根据该讨论自动修复并推送至本分支。'
          );
          console.log(`[MaintainerRunner] 已修复他人 discussion ${discussion.id}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MaintainerRunner] resolve 他人 discussion ${discussion.id} 失败: ${message}`);
        }
      } else {
        try {
          await provider.addDiscussionNote(
            mr.iid,
            discussion.id,
            `⏸️ CodeKeeper 决定暂不自动修复：${fixResult.reason}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MaintainerRunner] 回复 discussion ${discussion.id} 失败: ${message}`);
        }
      }
    }
  }
}
