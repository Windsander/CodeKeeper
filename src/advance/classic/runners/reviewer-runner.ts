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
import { buildEverOSAgentId, sanitizeEverOSId } from '../memory/types.js';
import { loadState, saveState, getDiscussionStateKey, type MrAgentState } from './shared/state-utils.js';
import {
  formatAgentFooter,
  isAgentAuthoredNote,
  REVIEWER_ROLE_LABEL,
} from './shared/review-utils.js';
import type { Project, RoleConfig, ReviewerConfig } from '../../types.js';
import type { MergeRequest, MrDiff, ReviewFinding, Discussion, ReviewerComment } from '../provider/types.js';
import { BaseRoleRunner } from './base-role-runner.js';

/**
 * 构建 finding case 的全局唯一 key，用于 EverOS 去重与召回。
 */
function buildFindingCaseKey(projectId: string, mrIid: number, finding: ReviewFinding): string {
  const safeProject = sanitizeEverOSId(projectId);
  const safeFile = sanitizeEverOSId(finding.file);
  const safeRule = sanitizeEverOSId(finding.ruleId ?? 'generic');
  return `case:${safeProject}:mr-${mrIid}:${safeFile}:${finding.line}:${safeRule}`;
}

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

    const { soul, projectContext } = this.loadRoleContext(project);

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
      const recallPlanner = memoryClient
        ? new RecallPlanner({ llmClient: this.llmClient, memoryClient })
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
      const findingsKeys = result.findings.map((f) => getFindingKey(f));
      const previousReview = state.reviewState?.[stateKey];
      const headSha = shaInfo?.headSha ?? '';
      const mrUpdatedAt = new Date(mr.updatedAt).getTime();

      const headChanged = previousReview ? previousReview.headSha !== headSha : true;
      const findingsChanged = previousReview ? previousReview.findingsHash !== findingsHash : true;

      // 提前拉取评论：既用于记录记忆，也用于判断之前的 summary 是否被删除
      let comments: ReviewerComment[] = [];
      try {
        comments = await provider.getReviewerComments(mr.iid);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ReviewerRunner] 获取 MR !${mr.iid} 评论失败: ${message}`);
      }

      const lastReviewedAt = previousReview?.reviewedAt ?? 0;
      const recordedNoteIds = new Set(previousReview?.reviewNoteIds ?? []);
      const newComments = comments.filter((c) => {
        if (recordedNoteIds.has(c.id)) return false;
        const ts = new Date(c.createdAt).getTime();
        return !Number.isNaN(ts) && ts > lastReviewedAt;
      });

      if (
        previousReview &&
        !headChanged &&
        !findingsChanged &&
        !Number.isNaN(mrUpdatedAt) &&
        mrUpdatedAt <= previousReview.reviewedAt &&
        newComments.length === 0
      ) {
        console.log(`[ReviewerRunner] MR !${mr.iid} 无新 commit、无新发现、无新评论，跳过`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      const postedFindingKeys = new Set((state.discussions[stateKey] ?? []).map((d) => d.findingKey));
      const newFindings = previousReview
        ? result.findings.filter(
            (f) =>
              !previousReview.findingsKeys.includes(getFindingKey(f)) &&
              !postedFindingKeys.has(getFindingKey(f))
          )
        : result.findings;

      // 通过 EverOS finding case 做跨实例/状态丢失兜底去重
      let newFindingsToPost = newFindings;
      if (memoryClient) {
        try {
          newFindingsToPost = await this.filterDuplicateCases(memoryClient, project.id, mr.iid, newFindings);
          const skipped = newFindings.length - newFindingsToPost.length;
          if (skipped > 0) {
            console.log(`[ReviewerRunner] MR !${mr.iid} 从新增发现项中过滤 ${skipped} 个 EverOS 已存在的 case`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ReviewerRunner] MR !${mr.iid} 召回 finding case 失败: ${message}`);
        }
      }

      // 如果之前保存的 summary note 已经被删除，则重新发 summary，而不是追加补充评审
      const previousSummaryNoteId = previousReview?.summaryNoteId;
      const summaryStillExists = previousSummaryNoteId
        ? comments.some((c) => c.id === previousSummaryNoteId)
        : false;
      const shouldPostSummary = !previousReview || !summaryStillExists;

      const newFindingsHash = computeFindingsHash(newFindingsToPost);
      const lastAppendStillExists =
        previousReview?.lastAppendNoteId !== undefined &&
        comments.some((c) => c.id === previousReview.lastAppendNoteId);
      const shouldAppend =
        !shouldPostSummary &&
        newFindingsToPost.length > 0 &&
        !(previousReview?.lastAppendFindingsHash === newFindingsHash && lastAppendStillExists);

      const reviewNoteIds: number[] = [];
      let summaryNoteId: number | undefined = previousSummaryNoteId;
      let lastAppendNoteId: number | undefined = previousReview?.lastAppendNoteId;
      let lastAppendFindingsHash: string | undefined = previousReview?.lastAppendFindingsHash;
      try {
        if (result.findings.length > 0 && shouldPostSummary) {
          const id = await actor.postReview(mr, result, {
            diffs,
            shaInfo,
            stateKey,
            state,
          });
          reviewNoteIds.push(id);
          summaryNoteId = id;
          lastAppendNoteId = undefined;
          lastAppendFindingsHash = undefined;
        } else if (shouldAppend) {
          const id = await actor.appendSupplementaryReview(mr, newFindingsToPost);
          reviewNoteIds.push(id);
          lastAppendNoteId = id;
          lastAppendFindingsHash = newFindingsHash;
        } else if (!shouldPostSummary && newFindingsToPost.length > 0 && !shouldAppend) {
          console.log(`[ReviewerRunner] MR !${mr.iid} 新增发现项与上一次追加评审重复，跳过追加`);
        } else if (result.findings.length === 0) {
          console.log(`[ReviewerRunner] MR !${mr.iid} 无发现问题，跳过发布评论`);
        }

        // 为新增 CRITICAL/HIGH finding 开 threads（已有 findingKey 的不会重复创建）
        if (newFindingsToPost.length > 0) {
          await actor.createFindingThreads(mr, newFindingsToPost, {
            diffs,
            shaInfo,
            stateKey,
            state,
          });
        }

        // 把新增 finding 记录为 EverOS case，供后续去重和跨 RoleAgent 检索
        if (memoryClient && newFindingsToPost.length > 0) {
          try {
            const cases = newFindingsToPost.map((f) => {
              const key = buildFindingCaseKey(project.id, mr.iid, f);
              const posted = state.discussions[stateKey]?.find((d) => d.findingKey === getFindingKey(f));
              return {
                key,
                mrIid: mr.iid,
                file: f.file,
                line: f.line,
                severity: f.severity,
                ruleId: f.ruleId,
                message: f.message,
                suggestion: f.suggestion,
                status: 'open' as const,
                discussionId: posted?.discussionId,
              };
            });
            await memoryClient.recordFindingCases(cases);
            console.log(`[ReviewerRunner] MR !${mr.iid} 已记录 ${cases.length} 个 finding case 到 EverOS`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[ReviewerRunner] MR !${mr.iid} 记录 finding case 失败: ${message}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 发布评论失败: ${message}`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      if (memoryClient) {
        try {
          // 只有在首次评审、HEAD 变化、发现变化或有新评论时才写入记忆，
          // 避免 MR 仅被无关更新（如标题编辑）触发时重复生成 episode。
          const shouldRecordMemory =
            !previousReview || headChanged || findingsChanged || newComments.length > 0;

          if (shouldRecordMemory) {
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
              mrAuthor: mr.author,
            });
            console.log(`[ReviewerRunner] MR !${mr.iid} 记忆写入请求已提交（EverOS 后台异步处理）`);
          } else {
            console.log(`[ReviewerRunner] MR !${mr.iid} 无新 commit/新发现/新评论，跳过记忆写入`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ReviewerRunner] MR !${mr.iid} 记忆写入失败: ${message}`);
        }
      }

      // 更新评审状态，避免周期性轮询导致重复 summary/记忆
      state.reviewState ??= {};
      state.reviewState[stateKey] = {
        findingsHash,
        findingsKeys,
        reviewedAt: Date.now(),
        headSha,
        summaryNoteId,
        reviewNoteIds: [...(previousReview?.reviewNoteIds ?? []), ...reviewNoteIds],
        lastAppendNoteId,
        lastAppendFindingsHash,
      };

      // 处理别人对 Reviewer 自己开的 discussion threads / summary 评论的新回复
      try {
        const discussions = await provider.getDiscussions(mr.iid);
        await this.handleThreadReplies(mr, discussions, result.findings, state, provider, brain, reviewerName, previousReview);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ReviewerRunner] MR !${mr.iid} 处理 discussion 回复失败: ${message}`);
      }

      await memoryClient?.disconnect().catch(() => undefined);
    }

    // 持久化 MR 评审状态，否则下一轮轮询会丢失 reviewState/discussions 记录，
    // 导致对同一 MR 重复发布 summary 和重复写入记忆。
    saveState(project, state);
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
    previousReview?: NonNullable<MrAgentState['reviewState']>[string]
  ): Promise<void> {
    const reviewerThreads = discussions.filter(
      (d) =>
        d.notes.length > 0 &&
        !d.resolved &&
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

      if (targetNotes.length === 0) {
        console.log(`[ReviewerRunner] discussion ${discussion.id} 没有新的人类回复`);
        continue;
      }

      console.log(
        `[ReviewerRunner] discussion ${discussion.id} 有 ${targetNotes.length} 条新的人类回复待处理`
      );

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
      findings.map(async (f) => {
        const key = buildFindingCaseKey(projectId, mrIid, f);
        try {
          const items = await memoryClient.recallFindingCase(key);
          const exists = items.some((item) => item.includes(`[CASE:${key}]`));
          return { finding: f, exists };
        } catch {
          return { finding: f, exists: false };
        }
      })
    );

    return checks.filter((c) => !c.exists).map((c) => c.finding);
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
