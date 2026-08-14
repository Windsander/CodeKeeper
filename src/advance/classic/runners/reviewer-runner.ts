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
import { MemoryClient } from '../memory/memory-client.js';
import { RecallPlanner } from '../memory/recall-planner.js';
import { buildEverOSAgentId } from '../memory/types.js';
import { buildFindingCaseKey } from '../memory/finding-case-key.js';
import {
  loadState,
  saveState,
  getDiscussionStateKey,
  type MrAgentState,
} from './shared/state-utils.js';
import {
  deliverReviewComment,
  isReviewCommentDeliveryPending,
} from './shared/review-comment-delivery.js';
import {
  deliverDiscussionReply,
  isDiscussionDeliveryPending,
} from './shared/discussion-delivery.js';
import {
  formatAgentFooter,
  isAgentAuthoredNote,
  isBotAuthor,
  REVIEWER_ROLE_LABEL,
} from './shared/review-utils.js';
import type { Project, RoleConfig, ReviewerConfig } from '../../types.js';
import type {
  MergeRequest,
  MrDiff,
  ReviewFinding,
  Discussion,
  ReviewerComment,
} from '../provider/types.js';
import { BaseRoleRunner } from './base-role-runner.js';
import { logger } from '../../../core/logger.js';
import { getCommentActivityAt } from '../provider/activity-window.js';
import {
  ArchiverProjectKnowledgeSource,
  mergeProjectKnowledgeContext,
} from '../../archiver/project-knowledge-source.js';

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
    if (!project.gitlab) {
      logger.warn({ projectId: project.id }, '项目未配置 GitLab，跳过 Reviewer 轮询');
      return;
    }
    const provider = new GitLabProvider(project.gitlab);
    const state = loadState(project);

    const { soul, projectContext: legacyProjectContext } = this.loadRoleContext(project);
    const projectKnowledgeSource = new ArchiverProjectKnowledgeSource({ project });
    const [providerContext, providerKnowledgeAvailable] = await Promise.all([
      projectKnowledgeSource.loadContext(6000).catch(() => ''),
      projectKnowledgeSource.isAvailable().catch(() => false),
    ]);
    const projectContext = mergeProjectKnowledgeContext(legacyProjectContext, providerContext);

    const reviewerConfig = config as ReviewerConfig;
    const reviewerName = reviewerConfig.reviewerName ?? 'CodeKeeper Reviewer';

    const mcpUrl = process.env.CK_EVEROS_MCP_URL ?? '';
    const reviewerAgentId = buildEverOSAgentId('reviewer', reviewerName);
    const baseMemoryContext = {
      appId: 'codekeeper-advance',
      projectId: project.id,
      agentId: reviewerAgentId,
      agentDisplayName: reviewerName,
      userId: 'codekeeper-system',
    };

    const brainOptions = {
      llmClient: this.llmClient,
      tokenBudget: 4000,
      rules: soul.content || '默认评审规则：检查代码质量、安全性、性能问题',
      soulContent: soul.content || undefined,
      projectContext,
    };
    const actor = new ReviewerActor({
      provider,
      project,
      reviewerName,
      threadRiskLevels: reviewerConfig.threadRiskLevels,
    });

    console.log(`[ReviewerRunner] 扫描项目 ${project.name} 的 open MRs...`);
    console.log(
      `[ReviewerRunner] 项目 ${project.name} 使用 filter: ${JSON.stringify(reviewerConfig.filter ?? {})}`
    );

    let mrs: MergeRequest[];
    try {
      mrs = await provider.listOpenMRs(reviewerConfig.filter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ReviewerRunner] 列出项目 ${project.name} 的 MR 失败: ${message}`);
      throw error;
    }

    console.log(`[ReviewerRunner] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);

    // 默认跳过 draft；如果 filter 里显式配置了 Draft=true，则保留 draft MR
    const draftCondition = reviewerConfig.filter?.conditions.find(c => c.field === 'draft');
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
      const previousReview = state.reviewState?.[stateKey];
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
      if (memoryClient) {
        await this.retryPendingReviewMemory(memoryClient, project, state, stateKey);
      }
      const recallPlanner =
        memoryClient || providerKnowledgeAvailable
          ? new RecallPlanner({
              llmClient: this.llmClient,
              memoryClient,
              projectKnowledgeSource: providerKnowledgeAvailable
                ? projectKnowledgeSource
                : undefined,
            })
          : undefined;
      const brain = new ReviewerBrain({ ...brainOptions, memoryClient, recallPlanner });

      let result;
      try {
        result = await brain.review(mr, diffs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] 评审 MR !${mr.iid} 失败: ${message}`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      const findingsHash = computeFindingsHash(result.findings);
      const findingsKeys = result.findings.map(f => getFindingKey(f));
      const headSha = shaInfo?.headSha ?? '';
      const mrUpdatedAt = new Date(mr.updatedAt).getTime();

      const headChanged = previousReview ? previousReview.headSha !== headSha : true;
      const findingsChanged = previousReview ? previousReview.findingsHash !== findingsHash : true;

      // 评论快照失败时不能把“未知”当成“远端为空”，否则会误补发 summary/append。
      let allComments: ReviewerComment[];
      let activeHumanComments: ReviewerComment[];
      try {
        const commentSnapshot = await provider.getReviewerCommentSnapshot(mr.iid);
        allComments = commentSnapshot.all;
        activeHumanComments = commentSnapshot.activeHuman;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[ReviewerRunner] 获取 MR !${mr.iid} 评论快照失败，本轮跳过远端评论副作用: ${message}`
        );
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      let recoveredDeliveries: { summaryNoteId?: number; appendNoteId?: number };
      try {
        recoveredDeliveries = await this.reconcileReviewCommentDeliveries(
          provider,
          mr,
          state,
          stateKey,
          allComments,
          project
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 恢复历史评论投递失败: ${message}`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }
      const summaryNoteIdFromState =
        recoveredDeliveries.summaryNoteId ?? previousReview?.summaryNoteId;
      const summaryStillExists = summaryNoteIdFromState
        ? allComments.some(comment => comment.id === summaryNoteIdFromState)
        : false;
      const threadRiskLevels = new Set<ReviewFinding['severity']>(
        reviewerConfig.threadRiskLevels ?? ['CRITICAL', 'HIGH']
      );
      const postedFindingKeys = new Set((state.discussions[stateKey] ?? []).map(d => d.findingKey));
      const missingThreadFindings = result.findings.filter(
        finding =>
          threadRiskLevels.has(finding.severity) && !postedFindingKeys.has(getFindingKey(finding))
      );
      const reviewDelivery = state.reviewCommentDelivery?.[stateKey];
      const hasPendingReviewDelivery =
        isReviewCommentDeliveryPending(reviewDelivery?.summary) ||
        isReviewCommentDeliveryPending(reviewDelivery?.append);

      const lastReviewedAt = previousReview?.reviewedAt ?? 0;
      const newComments = activeHumanComments.filter(
        comment => getCommentActivityAt(comment) > lastReviewedAt
      );

      if (
        previousReview &&
        !headChanged &&
        !findingsChanged &&
        !Number.isNaN(mrUpdatedAt) &&
        mrUpdatedAt <= previousReview.reviewedAt &&
        newComments.length === 0 &&
        summaryStillExists &&
        missingThreadFindings.length === 0 &&
        !hasPendingReviewDelivery
      ) {
        console.log(`[ReviewerRunner] MR !${mr.iid} 无新 commit、无新发现、无新评论，跳过`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      const newFindings = previousReview
        ? result.findings.filter(
            f =>
              !previousReview.findingsKeys.includes(getFindingKey(f)) &&
              !postedFindingKeys.has(getFindingKey(f))
          )
        : result.findings;

      // 通过 EverOS finding case 做跨实例/状态丢失兜底去重
      let newFindingsToPost = newFindings;
      if (memoryClient) {
        try {
          newFindingsToPost = await this.filterDuplicateCases(
            memoryClient,
            project.id,
            mr.iid,
            newFindings
          );
          const skipped = newFindings.length - newFindingsToPost.length;
          if (skipped > 0) {
            console.log(
              `[ReviewerRunner] MR !${mr.iid} 从新增发现项中过滤 ${skipped} 个 EverOS 已存在的 case`
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ReviewerRunner] MR !${mr.iid} 召回 finding case 失败: ${message}`);
        }
      }

      // 如果之前保存的 summary note 已经被删除，则重新发 summary，而不是追加补充评审
      const previousSummaryNoteId = summaryNoteIdFromState;
      const shouldPostSummary = !summaryStillExists;

      const newFindingsHash = computeFindingsHash(newFindingsToPost);
      const lastAppendStillExists =
        recoveredDeliveries.appendNoteId !== undefined ||
        (previousReview?.lastAppendNoteId !== undefined &&
          allComments.some(comment => comment.id === previousReview.lastAppendNoteId));
      const shouldAppend =
        !shouldPostSummary &&
        newFindingsToPost.length > 0 &&
        !(previousReview?.lastAppendFindingsHash === newFindingsHash && lastAppendStillExists);

      const reviewNoteIds: number[] = [];
      let summaryNoteId: number | undefined = previousSummaryNoteId;
      let lastAppendNoteId: number | undefined =
        recoveredDeliveries.appendNoteId ?? previousReview?.lastAppendNoteId;
      let lastAppendFindingsHash: string | undefined = previousReview?.lastAppendFindingsHash;
      try {
        if (result.findings.length > 0 && shouldPostSummary) {
          const id = await actor.postReview(mr, result, {
            diffs,
            shaInfo,
            stateKey,
            state,
            comments: allComments,
          });
          reviewNoteIds.push(id);
          summaryNoteId = id;
          lastAppendNoteId = undefined;
          lastAppendFindingsHash = undefined;
        } else if (shouldAppend) {
          const id = await actor.appendSupplementaryReview(mr, newFindingsToPost, {
            stateKey,
            state,
            comments: allComments,
          });
          reviewNoteIds.push(id);
          lastAppendNoteId = id;
          lastAppendFindingsHash = newFindingsHash;
        } else if (!shouldPostSummary && newFindingsToPost.length > 0 && !shouldAppend) {
          console.log(`[ReviewerRunner] MR !${mr.iid} 新增发现项与上一次追加评审重复，跳过追加`);
        } else if (result.findings.length === 0) {
          console.log(`[ReviewerRunner] MR !${mr.iid} 无发现问题，跳过发布评论`);
        }

        // 每轮都补齐当前 CRITICAL/HIGH finding threads；只依赖新增 finding 会永久漏掉上轮失败项。
        if (missingThreadFindings.length > 0) {
          await actor.createFindingThreads(mr, result.findings, {
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

      // 先持久化本轮记忆意图，再调用 EverOS；失败时由下一轮补偿，不再被最终 reviewState 覆盖。
      const shouldRecordMemory =
        !previousReview || headChanged || findingsChanged || newComments.length > 0;
      const reviewMemoryPayload = {
        mrIid: mr.iid,
        title: mr.title,
        findingsCount: result.findings.length,
        summary: result.summary,
        findings: result.findings.map(finding => ({
          severity: finding.severity,
          file: finding.file,
          line: finding.line,
          message: finding.message,
          suggestion: finding.suggestion,
          ruleId: finding.ruleId,
          autoFixable: finding.autoFixable,
        })),
        comments: newComments.map(comment => ({
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
        })),
        mrAuthor: mr.author,
      };
      const reviewMemoryKey = `${headSha}:${findingsHash}:${newComments
        .map(comment => `${comment.id}:${getCommentActivityAt(comment)}`)
        .join(',')}`;
      const memoryState = { ...(previousReview?.memory ?? {}) };
      if (
        shouldRecordMemory &&
        (!memoryState.review ||
          memoryState.review.key !== reviewMemoryKey ||
          memoryState.review.status !== 'recorded')
      ) {
        memoryState.review = {
          key: reviewMemoryKey,
          status: 'pending',
          payload: reviewMemoryPayload,
          attempts: 0,
          updatedAt: Date.now(),
        };
      }

      let currentCases: Array<{
        key: string;
        mrIid: number;
        file: string;
        line: number;
        severity: string;
        ruleId?: string;
        message: string;
        suggestion?: string;
        status: 'open';
        discussionId?: string;
      }> = [];
      if (newFindingsToPost.length > 0) {
        currentCases = newFindingsToPost.map(finding => {
          const key = buildFindingCaseKey({
            projectId: project.id,
            mrIid: mr.iid,
            file: finding.file,
            line: finding.line,
            ruleId: finding.ruleId,
          });
          const posted = state.discussions[stateKey]?.find(
            discussion => discussion.findingKey === getFindingKey(finding)
          );
          return {
            key,
            mrIid: mr.iid,
            file: finding.file,
            line: finding.line,
            severity: finding.severity,
            ruleId: finding.ruleId,
            message: finding.message,
            suggestion: finding.suggestion,
            status: 'open' as const,
            discussionId: posted?.discussionId,
          };
        });
        const casesKey = currentCases
          .map(item => item.key)
          .sort()
          .join('|');
        if (
          !memoryState.findingCases ||
          memoryState.findingCases.key !== casesKey ||
          memoryState.findingCases.status !== 'recorded'
        ) {
          memoryState.findingCases = {
            key: casesKey,
            status: 'pending',
            cases: currentCases,
            attempts: 0,
            updatedAt: Date.now(),
          };
        }
      }

      state.reviewState ??= {};
      state.reviewState[stateKey] = {
        ...(previousReview ?? {
          findingsHash,
          findingsKeys,
          reviewedAt: 0,
        }),
        memory: memoryState,
      };
      saveState(project, state, 'reviewer');

      if (memoryClient) {
        const pendingCases = memoryState.findingCases;
        if (pendingCases && pendingCases.status !== 'recorded') {
          pendingCases.status = 'pending';
          pendingCases.attempts += 1;
          pendingCases.lastError = undefined;
          pendingCases.updatedAt = Date.now();
          saveState(project, state, 'reviewer');
          try {
            await memoryClient.recordFindingCases(pendingCases.cases);
            pendingCases.status = 'recorded';
            pendingCases.lastError = undefined;
            pendingCases.updatedAt = Date.now();
            console.log(
              `[ReviewerRunner] MR !${mr.iid} 已记录 ${pendingCases.cases.length} 个 finding case 到 EverOS`
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            pendingCases.status = 'failed';
            pendingCases.lastError = message;
            pendingCases.updatedAt = Date.now();
            console.error(`[ReviewerRunner] MR !${mr.iid} 记录 finding case 失败: ${message}`);
          }
          saveState(project, state, 'reviewer');
        }

        const pendingReview = memoryState.review;
        if (pendingReview && pendingReview.status !== 'recorded') {
          pendingReview.status = 'pending';
          pendingReview.attempts += 1;
          pendingReview.lastError = undefined;
          pendingReview.updatedAt = Date.now();
          saveState(project, state, 'reviewer');
          try {
            await memoryClient.recordReview(pendingReview.payload);
            pendingReview.status = 'recorded';
            pendingReview.lastError = undefined;
            pendingReview.updatedAt = Date.now();
            console.log(`[ReviewerRunner] MR !${mr.iid} 记忆写入请求已提交（EverOS 后台异步处理）`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            pendingReview.status = 'failed';
            pendingReview.lastError = message;
            pendingReview.updatedAt = Date.now();
            console.error(`[ReviewerRunner] MR !${mr.iid} 记忆写入失败: ${message}`);
          }
          saveState(project, state, 'reviewer');
        } else if (!shouldRecordMemory) {
          console.log(`[ReviewerRunner] MR !${mr.iid} 无新 commit/新发现/新评论，跳过记忆写入`);
        }
      }

      // 更新评审状态，避免周期性轮询导致重复 summary/记忆
      state.reviewState ??= {};
      const reviewNoteHeadShas = { ...(previousReview?.reviewNoteHeadShas ?? {}) };
      for (const noteId of reviewNoteIds) {
        reviewNoteHeadShas[String(noteId)] = headSha;
      }
      state.reviewState[stateKey] = {
        findingsHash,
        findingsKeys,
        reviewedAt: Date.now(),
        headSha,
        summaryNoteId,
        reviewNoteIds: [...(previousReview?.reviewNoteIds ?? []), ...reviewNoteIds],
        reviewNoteHeadShas,
        lastAppendNoteId,
        lastAppendFindingsHash,
        memory: memoryState,
      };
      saveState(project, state, 'reviewer');

      // 处理别人对 Reviewer 自己开的 discussion threads / summary 评论的新回复
      try {
        const discussionSnapshot = await provider.getDiscussionSnapshot(mr.iid);
        const trackedDiscussionIds = new Set<string>([
          ...(state.discussions[stateKey] ?? []).map(item => item.discussionId),
          ...Object.keys(state.reviewerThreadState ?? {}),
        ]);
        const discussions = this.includeTrackedDiscussions(
          discussionSnapshot.active,
          discussionSnapshot.all,
          trackedDiscussionIds
        );
        await this.handleThreadReplies(
          mr,
          discussions,
          result.findings,
          state,
          provider,
          brain,
          reviewerName,
          previousReview,
          project
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 处理 discussion 回复失败: ${message}`);
      }

      await memoryClient?.disconnect().catch(() => undefined);
    }

    // 持久化 MR 评审状态，否则下一轮轮询会丢失 reviewState/discussions 记录，
    // 导致对同一 MR 重复发布 summary 和重复写入记忆。
    saveState(project, state, 'reviewer');
  }

  /**
   * 处理 Reviewer 自己创建的 discussion threads / summary 评论中的人类回复
   *
   * 不再只依赖 state.discussions 中记录的 finding thread，而是直接扫描 GitLab 上
   * 所有由 Reviewer Agent（通过签名 footer 识别）发布的 discussion，这样用户在
   * summary 评论或 MEDIUM/LOW finding 相关评论下的追问也能被回复。
   */
  private async handleThreadReplies(
    mr: MergeRequest,
    discussions: Discussion[],
    originalFindings: ReviewFinding[],
    state: MrAgentState,
    provider: GitLabProvider,
    brain: ReviewerBrain,
    reviewerName: string,
    previousReview?: NonNullable<MrAgentState['reviewState']>[string],
    project?: Project
  ): Promise<void> {
    const reviewerThreads = discussions.filter(
      d =>
        d.notes.length > 0 &&
        isAgentAuthoredNote(d.notes[0].body) &&
        d.notes[0].body.includes(REVIEWER_ROLE_LABEL)
    );
    if (reviewerThreads.length === 0) {
      console.log(`[ReviewerRunner] MR !${mr.iid} 未发现 Reviewer 拥有的可回复 discussion`);
      return;
    }

    console.log(
      `[ReviewerRunner] MR !${mr.iid} 发现 ${reviewerThreads.length} 个 Reviewer discussion，检查新回复...`
    );

    const baselineTime = previousReview?.reviewedAt ?? 0;

    for (const discussion of reviewerThreads) {
      state.reviewerThreadState ??= {};
      const threadState = (state.reviewerThreadState[discussion.id] ??= {
        lastRepliedAt: baselineTime,
      });

      const delivery = threadState.delivery;
      const deliveryNoteExists = Boolean(
        delivery &&
        discussion.notes.some(
          note => note.id === delivery.replyNoteId || note.body === delivery.replyBody
        )
      );
      const shouldReconcileDelivery = Boolean(
        delivery &&
        (threadState.pendingTargetNoteId !== undefined ||
          isDiscussionDeliveryPending(delivery) ||
          (delivery.replyStatus === 'posted' && !deliveryNoteExists))
      );
      if (shouldReconcileDelivery && delivery) {
        const pendingResult = await deliverDiscussionReply({
          provider,
          mr,
          discussion,
          body: delivery.replyBody,
          resolve: false,
          delivery,
          setDelivery: delivery => {
            threadState.delivery = delivery;
          },
          checkpoint: () => {
            if (project) saveState(project, state, 'reviewer');
          },
        });
        if (pendingResult.pending) {
          console.warn(
            `[ReviewerRunner] discussion ${discussion.id} 上次回复仍待重试: ${pendingResult.error ?? '未知错误'}`
          );
          continue;
        }
        if (threadState.pendingTargetNoteId !== undefined) {
          threadState.lastRepliedAt = Math.max(
            threadState.lastRepliedAt,
            threadState.pendingTargetCreatedAt ?? 0
          );
          threadState.pendingTargetNoteId = undefined;
          threadState.pendingTargetCreatedAt = undefined;
        }
        if (project) saveState(project, state, 'reviewer');
      }

      if (discussion.resolved) {
        console.log(`[ReviewerRunner] discussion ${discussion.id} 已解决，仅完成投递对账`);
        continue;
      }

      const lastRepliedAt = threadState.lastRepliedAt;

      const targetNotes = discussion.notes
        .filter(note => {
          const ts = getCommentActivityAt(note);
          return (
            !Number.isNaN(ts) &&
            ts > lastRepliedAt &&
            !isAgentAuthoredNote(note.body) &&
            !isBotAuthor(note.author)
          );
        })
        .sort((a, b) => getCommentActivityAt(a) - getCommentActivityAt(b));

      if (targetNotes.length === 0) {
        console.log(`[ReviewerRunner] discussion ${discussion.id} 没有新的人类回复`);
        continue;
      }

      console.log(
        `[ReviewerRunner] discussion ${discussion.id} 有 ${targetNotes.length} 条新的人类回复待处理`
      );

      const threadNotes = discussion.notes.map(n => ({
        author: n.author,
        body: n.body,
        createdAt: n.createdAt,
      }));

      const replyFooter = formatAgentFooter(REVIEWER_ROLE_LABEL, reviewerName);
      for (const note of targetNotes) {
        const noteTs = getCommentActivityAt(note);
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
          console.log(
            `[ReviewerRunner] discussion ${discussion.id} 的回复判断: ${decision.reason}`
          );
          threadState.lastRepliedAt = Math.max(threadState.lastRepliedAt, noteTs);
          if (project) saveState(project, state, 'reviewer');
          continue;
        }

        const replyBody = `${decision.replyBody}\n\n${replyFooter}`;
        threadState.pendingTargetNoteId = note.id;
        threadState.pendingTargetCreatedAt = noteTs;
        if (project) saveState(project, state, 'reviewer');
        const replyResult = await deliverDiscussionReply({
          provider,
          mr,
          discussion,
          body: replyBody,
          resolve: false,
          delivery: threadState.delivery,
          setDelivery: delivery => {
            threadState.delivery = delivery;
          },
          checkpoint: () => {
            if (project) saveState(project, state, 'reviewer');
          },
        });
        if (replyResult.pending) {
          console.error(
            `[ReviewerRunner] 回复 discussion ${discussion.id} 失败，保留待重试状态: ${replyResult.error ?? '未知错误'}`
          );
          break;
        }
        console.log(`[ReviewerRunner] 已回复 discussion ${discussion.id}: ${decision.reason}`);
        threadState.lastRepliedAt = Math.max(threadState.lastRepliedAt, noteTs);
        threadState.pendingTargetNoteId = undefined;
        threadState.pendingTargetCreatedAt = undefined;
        if (project) saveState(project, state, 'reviewer');
      }
    }
  }

  private async reconcileReviewCommentDeliveries(
    provider: GitLabProvider,
    mr: MergeRequest,
    state: MrAgentState,
    stateKey: string,
    comments: ReviewerComment[],
    project: Project
  ): Promise<{ summaryNoteId?: number; appendNoteId?: number }> {
    const deliveryState = state.reviewCommentDelivery?.[stateKey];
    if (!deliveryState) return {};

    const reconcile = async (kind: 'summary' | 'append'): Promise<number | undefined> => {
      const delivery = deliveryState[kind];
      if (!delivery) return undefined;
      const result = await deliverReviewComment({
        provider,
        mr,
        body: delivery.body,
        comments,
        delivery,
        setDelivery: nextDelivery => {
          deliveryState[kind] = nextDelivery;
        },
        checkpoint: () => saveState(project, state, 'reviewer'),
      });
      if (!result.posted) {
        throw new Error(result.error ?? `Reviewer ${kind} 评论恢复失败`);
      }
      return result.noteId;
    };

    return {
      summaryNoteId: await reconcile('summary'),
      appendNoteId: await reconcile('append'),
    };
  }

  private includeTrackedDiscussions(
    active: Discussion[],
    all: Discussion[],
    trackedIds: Set<string>
  ): Discussion[] {
    const selected = new Map(active.map(discussion => [discussion.id, discussion]));
    for (const discussion of all) {
      if (trackedIds.has(discussion.id)) selected.set(discussion.id, discussion);
    }
    return [...selected.values()];
  }

  /**
   * 按 case key 召回 EverOS 中是否已有对应 finding case，返回需要去重过滤后的 findings。
   */
  private async filterDuplicateCases(
    memoryClient: MemoryClient,
    projectId: string,
    mrIid: number,
    findings: ReviewFinding[]
  ): Promise<ReviewFinding[]> {
    if (findings.length === 0) return findings;

    const checks = await Promise.all(
      findings.map(async f => {
        const key = buildFindingCaseKey({
          projectId,
          mrIid,
          file: f.file,
          line: f.line,
          ruleId: f.ruleId,
        });
        try {
          const items = await memoryClient.recallFindingCase(key);
          const exists = items.some(item => item.includes(`[CASE:${key}]`));
          return { finding: f, exists };
        } catch {
          return { finding: f, exists: false };
        }
      })
    );

    return checks.filter(c => !c.exists).map(c => c.finding);
  }

  private async retryPendingReviewMemory(
    memoryClient: MemoryClient,
    project: Project,
    state: MrAgentState,
    stateKey: string
  ): Promise<void> {
    const reviewState = state.reviewState?.[stateKey];
    const memoryState = reviewState?.memory;
    if (!memoryState) return;

    if (memoryState.findingCases && memoryState.findingCases.status !== 'recorded') {
      const pending = memoryState.findingCases;
      pending.status = 'pending';
      pending.attempts += 1;
      pending.lastError = undefined;
      pending.updatedAt = Date.now();
      saveState(project, state, 'reviewer');
      try {
        await memoryClient.recordFindingCases(pending.cases);
        pending.status = 'recorded';
        pending.updatedAt = Date.now();
        console.log(`[ReviewerRunner] 已补偿写入 ${pending.cases.length} 个待处理 finding case`);
      } catch (error) {
        pending.status = 'failed';
        pending.lastError = error instanceof Error ? error.message : String(error);
        pending.updatedAt = Date.now();
        console.warn(`[ReviewerRunner] 补偿 finding case 写入失败: ${pending.lastError}`);
      }
      saveState(project, state, 'reviewer');
    }

    if (memoryState.review && memoryState.review.status !== 'recorded') {
      const pending = memoryState.review;
      pending.status = 'pending';
      pending.attempts += 1;
      pending.lastError = undefined;
      pending.updatedAt = Date.now();
      saveState(project, state, 'reviewer');
      try {
        await memoryClient.recordReview(pending.payload);
        pending.status = 'recorded';
        pending.updatedAt = Date.now();
        console.log(`[ReviewerRunner] 已补偿写入待处理 Reviewer 记忆`);
      } catch (error) {
        pending.status = 'failed';
        pending.lastError = error instanceof Error ? error.message : String(error);
        pending.updatedAt = Date.now();
        console.warn(`[ReviewerRunner] 补偿 Reviewer 记忆写入失败: ${pending.lastError}`);
      }
      saveState(project, state, 'reviewer');
    }
  }
}

function computeFindingsHash(findings: ReviewFinding[]): string {
  const canonical = [...findings]
    .sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    })
    .map(f => ({
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
