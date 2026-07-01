/**
 * Reviewer 角色的 Runner 实现
 *
 * 负责：拉取 MR、调用 ReviewerBrain 生成 findings、调用 ReviewerActor 发布 summary。
 * 不处理 discussion 创建、auto-fix 或 resolve。
 */

import { LlmClient } from '../../llm/client.js';
import { GitLabProvider } from '../provider/gitlab-provider.js';
import { ReviewerBrain } from '../review/reviewer-brain.js';
import { ReviewerActor } from '../review/reviewer-actor.js';
import { loadSoulContent } from '../soul/soul-loader.js';
import { loadProjectContext } from '../context/project-context-loader.js';
import { MemoryClient } from '../memory/memory-client.js';
import { getArchiveRoot } from '../../types.js';
import { loadState, getDiscussionStateKey } from './shared/state-utils.js';
import type { Project, RoleConfig } from '../../types.js';
import type { MergeRequest, MrDiff } from '../provider/types.js';
import { BaseRoleRunner } from './base-role-runner.js';

/**
 * 构建 Reviewer 会话 ID（按 MR 粒度）
 */
export function buildReviewerSessionId(projectId: string, mrIid: number): string {
  return `reviewer-${projectId}-mr-${mrIid}`;
}

/**
 * ReviewerRunner 构造选项
 */
export interface ReviewerRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
}

export class ReviewerRunner extends BaseRoleRunner {
  constructor(options: ReviewerRunnerOptions) {
    super({ llmClient: options.llmClient });
  }

  protected getRole(): 'reviewer' {
    return 'reviewer';
  }

  protected getDefaultSchedule(): string {
    return '*/10 * * * *';
  }

  /**
   * 对单个项目执行 MR 评审轮询
   */
  protected async runProject(project: Project, config: RoleConfig): Promise<void> {
    const provider = new GitLabProvider(project.gitlab!);
    const state = loadState(project);

    const soul = loadSoulContent(project, 'reviewer');
    const projectContext = loadProjectContext(getArchiveRoot(project));

    const mcpUrl = process.env.CK_EVEROS_MCP_URL ?? '';
    const baseMemoryContext = {
      appId: 'codekeeper-advance',
      projectId: project.id,
      agentId: 'reviewer',
      userId: 'codekeeper-system',
    };

    const brainOptions = {
      llmClient: this.llmClient,
      tokenBudget: 4000,
      rules: soul.content || '默认评审规则：检查代码质量、安全性、性能问题',
      soulContent: soul.content || undefined,
      projectContext,
    };
    const actor = new ReviewerActor({ provider, project });

    console.log(`[ReviewerRunner] 扫描项目 ${project.name} 的 open MRs...`);
    console.log(`[ReviewerRunner] 项目 ${project.name} 使用 filter: ${JSON.stringify(config.filter ?? {})}`);

    let mrs: MergeRequest[];
    try {
      mrs = await provider.listOpenMRs(config.filter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerRunner] 列出项目 ${project.name} 的 MR 失败: ${message}`);
      throw error;
    }

    console.log(`[ReviewerRunner] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);

    // 默认跳过 draft；如果 filter 里显式配置了 Draft=true，则保留 draft MR
    const draftCondition = config.filter?.conditions.find((c) => c.field === 'draft');
    const includeDraft = draftCondition?.values.includes('true') ?? false;

    for (const mr of mrs) {
      if (mr.draft && !includeDraft) {
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

      let shaInfo;
      try {
        shaInfo = await provider.getMRShaInfo(mr.iid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] 获取 MR !${mr.iid} SHA 失败: ${message}`);
      }

      const stateKey = getDiscussionStateKey(mr);
      state.discussions[stateKey] ??= [];
      let memoryClient: MemoryClient | undefined;
      if (mcpUrl) {
        memoryClient = new MemoryClient({
          mcpUrl,
          context: {
            ...baseMemoryContext,
            sessionId: buildReviewerSessionId(project.id, mr.iid),
          },
        });
        try {
          await memoryClient.connect();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ReviewerRunner] MR !${mr.iid} MemoryClient 连接失败: ${message}`);
          memoryClient = undefined;
        }
      }
      const brain = new ReviewerBrain({ ...brainOptions, memoryClient });

      let result;
      try {
        result = await brain.review(mr, diffs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] 评审 MR !${mr.iid} 失败: ${message}`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      if (result.findings.length === 0) {
        console.log(`[ReviewerRunner] MR !${mr.iid} 无发现问题`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      try {
        await actor.postReview(mr, result, {
          diffs,
          shaInfo,
          stateKey,
          state,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 发布评论失败: ${message}`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      if (memoryClient) {
        try {
          await memoryClient.recordReview({
            mrIid: mr.iid,
            title: mr.title,
            findingsCount: result.findings.length,
            summary: result.summary,
            findings: result.findings,
          });
          console.log(`[ReviewerRunner] MR !${mr.iid} 记忆写入成功`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ReviewerRunner] MR !${mr.iid} 记忆写入失败: ${message}`);
        }
      }
      await memoryClient?.disconnect().catch(() => undefined);
    }
  }
}
