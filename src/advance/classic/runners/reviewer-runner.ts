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
import { loadState, getDiscussionStateKey, type MrAgentState } from './shared/state-utils.js';
import {
  formatAgentFooter,
  isAgentAuthoredNote,
  REVIEWER_ROLE_LABEL,
} from './shared/review-utils.js';
import type { Project, RoleConfig, ReviewerConfig } from '../../types.js';
import type { MergeRequest, MrDiff, ReviewFinding, Discussion } from '../provider/types.js';
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
    const reviewerConfig = config as ReviewerConfig;
    const reviewerName = reviewerConfig.reviewerName ?? 'CodeKeeper Reviewer';
    const actor = new ReviewerActor({
      provider,
      project,
      reviewerName,
      threadRiskLevels: reviewerConfig.threadRiskLevels,
    });

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

      const findingsHash = computeFindingsHash(result.findings);
      const findingsKeys = result.findings.map((f) => getFindingKey(f));
      const previousReview = state.reviewState?.[stateKey];
      const headSha = shaInfo?.headSha ?? '';
      const mrUpdatedAt = new Date(mr.updatedAt).getTime();

      const headChanged = previousReview ? previousReview.headSha !== headSha : true;
      const findingsChanged = previousReview ? previousReview.findingsHash !== findingsHash : true;

      if (
        previousReview &&
        !headChanged &&
        !findingsChanged &&
        !Number.isNaN(mrUpdatedAt) &&
        mrUpdatedAt <= previousReview.reviewedAt
      ) {
        console.log(`[ReviewerRunner] MR !${mr.iid} 无新 commit、无新发现，跳过发布与记忆写入`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      const newFindings = previousReview
        ? result.findings.filter((f) => !previousReview.findingsKeys.includes(getFindingKey(f)))
        : result.findings;

      try {
        if (!previousReview) {
          await actor.postReview(mr, result, {
            diffs,
            shaInfo,
            stateKey,
            state,
          });
        } else if (newFindings.length > 0) {
          await actor.appendSupplementaryReview(mr, newFindings);
        }

        // 为新增 CRITICAL/HIGH finding 开 threads（已有 findingKey 的不会重复创建）
        if (newFindings.length > 0) {
          await actor.createFindingThreads(mr, newFindings, {
            diffs,
            shaInfo,
            stateKey,
            state,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 发布评论失败: ${message}`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      if (memoryClient) {
        try {
          const comments = await provider.getReviewerComments(mr.iid);
          const lastReviewedAt = previousReview?.reviewedAt ?? 0;
          const newComments = comments.filter((c) => {
            const ts = new Date(c.createdAt).getTime();
            return !Number.isNaN(ts) && ts > lastReviewedAt;
          });
          await memoryClient.recordReview({
            mrIid: mr.iid,
            title: mr.title,
            findingsCount: result.findings.length,
            summary: result.summary,
            findings: result.findings,
            comments: newComments.map((c) => ({
              author: c.author,
              body: c.body,
              createdAt: c.createdAt,
            })),
          });
          console.log(`[ReviewerRunner] MR !${mr.iid} 记忆写入成功`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ReviewerRunner] MR !${mr.iid} 记忆写入失败: ${message}`);
        }
      }

      // 更新评审状态，避免周期性轮询导致重复 summary/记忆
      state.reviewState ??= {};
      state.reviewState[stateKey] = { findingsHash, findingsKeys, reviewedAt: Date.now(), headSha };

      // 处理别人对 Reviewer 自己开的 discussion threads 的新回复
      try {
        const discussions = await provider.getDiscussions(mr.iid);
        await this.handleThreadReplies(mr, discussions, result.findings, state, stateKey, provider, brain, reviewerName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 处理 discussion 回复失败: ${message}`);
      }

      await memoryClient?.disconnect().catch(() => undefined);
    }
  }

  /**
   * 处理 Reviewer 自己创建的 discussion threads 中的人类回复
   */
  private async handleThreadReplies(
    mr: MergeRequest,
    discussions: Discussion[],
    originalFindings: ReviewFinding[],
    state: MrAgentState,
    stateKey: string,
    provider: GitLabProvider,
    brain: ReviewerBrain,
    reviewerName: string
  ): Promise<void> {
    const reviewerDiscussionIds = new Set(
      (state.discussions[stateKey] ?? []).map((p) => p.discussionId)
    );
    if (reviewerDiscussionIds.size === 0) return;

    const reviewerThreads = discussions.filter(
      (d) => reviewerDiscussionIds.has(d.id) && !d.resolved && d.resolvable
    );
    if (reviewerThreads.length === 0) return;

    const previousReview = state.reviewState?.[stateKey];
    const baselineTime = previousReview?.reviewedAt ?? 0;

    for (const discussion of reviewerThreads) {
      const threadState = state.reviewerThreadState?.[discussion.id];
      const lastRepliedAt = threadState?.lastRepliedAt ?? baselineTime;

      const targetNotes = discussion.notes
        .filter((note) => {
          const ts = new Date(note.createdAt).getTime();
          return (
            !Number.isNaN(ts) &&
            ts > lastRepliedAt &&
            !isAgentAuthoredNote(note.body)
          );
        })
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      if (targetNotes.length === 0) continue;

      const threadNotes = discussion.notes.map((n) => ({
        author: n.author,
        body: n.body,
        createdAt: n.createdAt,
      }));

      let latestRepliedAt = lastRepliedAt;
      const replyFooter = formatAgentFooter(REVIEWER_ROLE_LABEL, reviewerName);
      for (const note of targetNotes) {
        const decision = await brain.replyToComment({
          mr,
          originalFindings,
          threadNotes,
          targetNote: {
            author: note.author,
            body: note.body,
            createdAt: note.createdAt,
          },
        });

        if (!decision.shouldReply || !decision.replyBody?.trim()) {
          console.log(`[ReviewerRunner] discussion ${discussion.id} 的回复判断: ${decision.reason}`);
          continue;
        }

        const replyBody = `${decision.replyBody}\n\n${replyFooter}`;
        try {
          await provider.addDiscussionNote(mr.iid, discussion.id, replyBody);
          console.log(`[ReviewerRunner] 已回复 discussion ${discussion.id}: ${decision.reason}`);
          const noteTs = new Date(note.createdAt).getTime();
          if (noteTs > latestRepliedAt) latestRepliedAt = noteTs;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[ReviewerRunner] 回复 discussion ${discussion.id} 失败: ${message}`);
        }
      }

      if (latestRepliedAt > lastRepliedAt) {
        state.reviewerThreadState ??= {};
        state.reviewerThreadState[discussion.id] = { lastRepliedAt: latestRepliedAt };
      }
    }
  }
}

function computeFindingsHash(findings: ReviewFinding[]): string {
  const canonical = [...findings]
    .sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    })
    .map((f) => ({
      severity: f.severity,
      file: f.file,
      line: f.line,
      message: f.message,
      ruleId: f.ruleId,
    }));
  return JSON.stringify(canonical);
}

function getFindingKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}:${finding.ruleId ?? 'generic'}`;
}
