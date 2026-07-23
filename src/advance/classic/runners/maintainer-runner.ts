/**
 * Maintainer 角色的 Runner 实现
 *
 * 负责：读取 MR 下所有 Reviewer/人工创建的 discussion，协调 MaintainerBrain 做决策、
 * MaintainerActor 执行修复或回复，并通过评论与 Reviewer 交互。
 * 不主动发现新问题，也不发布 review summary。
 */

import { LlmClient } from '../../llm/client.js';
import { GitLabProvider } from '../provider/gitlab-provider.js';
import { WorktreeManager } from '../worktree/worktree-manager.js';
import { MaintainerBrain } from '../fix/maintainer-brain.js';
import { MaintainerActor, type MaintainerActionResult } from '../fix/maintainer-actor.js';
import { CognitiveEngine } from '../cognitive-engine.js';
import { MemoryClient } from '../memory/memory-client.js';
import { RecallPlanner } from '../memory/recall-planner.js';
import type { Project, RoleConfig, MaintainerConfig } from '../../types.js';
import type { MergeRequest, ReviewFinding, Discussion } from '../provider/types.js';
import type { MrContext } from '../fix/cognitive-types.js';
import { buildAuthenticatedRemoteUrl } from './shared/config-utils.js';
import { logger } from '../../../core/logger.js';
import { loadState, saveState, type MrAgentState } from './shared/state-utils.js';
import {
  formatAgentFooter,
  isAgentAuthoredNote,
  isBotAuthor,
  isMaintainerAuthoredNote,
  isMaintainerNoFixExplanationNote,
  MAINTAINER_ROLE_LABEL,
} from './shared/review-utils.js';
import { readDiscussionFileContent } from './shared/discussion-file-reader.js';
import { focusedContextToString } from '../fix/focused-context-streamer.js';
import { isDiscussionPending, INTERACTIVE_REPLY_TIMEOUT_MS } from './shared/maintainer-filter.js';
import { parseStructuredCiReview } from './shared/ci-review-parser.js';
import {
  deliverDiscussionReply,
  isDiscussionDeliveryPending,
  type DiscussionDeliveryResult,
} from './shared/discussion-delivery.js';
import {
  getCommentActivityAt,
  getCommentUpdatedAt,
} from '../provider/activity-window.js';

function logMemoryUsage(label: string): void {
  const usage = process.memoryUsage();
  logger.info(
    {
      label,
      rssMB: Math.round(usage.rss / 1024 / 1024),
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
    },
    '内存使用快照'
  );
}
import { BaseRoleRunner } from './base-role-runner.js';

/**
 * 构建 Maintainer 修复尝试会话 ID（按 MR 粒度）
 */
export function buildMaintainerMrSessionId(projectId: string, mrIid: number): string {
  return `maintainer-${projectId}-mr-${mrIid}`;
}

/** 单条 finding 最大自动修复重试次数 */
const MAX_FIX_RETRY_ATTEMPTS = 3;

function normalizeMaintainerActionResult(
  result: MaintainerActionResult | boolean | undefined
): MaintainerActionResult {
  if (typeof result === 'object' && result !== null) return result;
  const codeApplied = result === true;
  return {
    codeApplied,
    replyPosted: false,
    resolved: false,
    awaitingReply: false,
    pending: false,
  };
}

function getFindingKey(finding: ReviewFinding): string {
  return `${finding.file}:${finding.line}`;
}

/**
 * 获取 discussion 中最近一条「人工追评」note 的时间戳（毫秒）。
 *
 * discussion 首条 note 是问题来源，不属于后续追评，即使其作者名无法识别为 bot
 * （例如令牌账号或自定义 Reviewer 用户名），也不能据此阻止 stale finding 复核。
 * 人工追评指首条之后、非任何 Agent（评审/维护）、也非自动化 bot 发布的 note。
 * 只有人工新回复才可能带来改变已有结论的新信息；
 * Agent/bot 自动重扫或补发的 note 不含新信息，不应触发重评估。
 */
function getLastHumanNoteAt(discussion: Discussion): number {
  return discussion.notes
    .slice(1)
    .filter(note => !isAgentAuthoredNote(note.body) && !isBotAuthor(note.author))
    .reduce((max, note) => {
      return Math.max(max, getCommentActivityAt(note));
    }, 0);
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

/**
 * 构建稳定的 summary 状态哈希。
 *
 * 仅使用 finding 定位和处理状态参与去重，不把 LLM 生成的自然语言说明纳入哈希，
 * 避免同一批 finding 每轮换一种措辞就被误判为新结果并重复发布汇总。
 */
export function buildSummaryStateHash(
  fixedItems: string[],
  failedItems: string[],
  askedItems: Array<{ fileLine: string }>,
  ignoredItems: Array<{ fileLine: string }>,
  alreadyFixedItems: Array<{ fileLine: string }>
): string {
  const stateKeys = [
    ...fixedItems.map(fileLine => `fixed:${fileLine}`),
    ...failedItems.map(item => `failed:${item.split(' — ')[0]}`),
    ...askedItems.map(item => `ask:${item.fileLine}`),
    ...ignoredItems.map(item => `ignored:${item.fileLine}`),
    ...alreadyFixedItems.map(item => `already-fixed:${item.fileLine}`),
  ].sort();
  return simpleHash(JSON.stringify(stateKeys));
}

function isReviewCommitStale(
  reviewCommit: string | undefined,
  currentHeadSha: string | undefined
): boolean {
  if (!reviewCommit || !currentHeadSha) return false;
  const review = reviewCommit.toLowerCase();
  const head = currentHeadSha.toLowerCase();
  return !head.startsWith(review) && !review.startsWith(head);
}

function extractReviewCommit(body: string): string | undefined {
  return body.match(/\bcommit\s+([0-9a-f]{7,40})\b/i)?.[1]?.toLowerCase();
}

function getDiscussionReviewCommit(
  mr: MergeRequest,
  discussion: Discussion,
  firstNoteId: number,
  state: MrAgentState,
  structuredCommit?: string
): string | undefined {
  if (structuredCommit) return structuredCommit;
  if (discussion.position?.headSha) return discussion.position.headSha;

  const reviewState = state.reviewState?.[`${mr.sourceBranch}:${mr.targetBranch}`];
  return reviewState?.reviewNoteHeadShas?.[String(firstNoteId)];
}

export function hasHeadChangedSinceProcessing(
  discussion: Discussion,
  state: MrAgentState,
  currentHeadSha: string | undefined
): boolean {
  if (!currentHeadSha || discussion.resolved || !discussion.resolvable) return false;
  if (state.interactiveThreads?.[discussion.id]?.status === 'awaiting-reply') return false;
  const processedHead = state.maintainerThreadState?.[discussion.id]?.lastProcessedHeadSha;
  return Boolean(processedHead && isReviewCommitStale(processedHead, currentHeadSha));
}

/**
 * 顺序处理一组 discussion，并隔离单条 discussion 的异常。
 *
 * Maintainer 的记忆写入可能早于回复或修复工具完成；单条异常不能因此中断同一 MR
 * 的后续 discussion，否则会出现“记忆持续增长但只有第一条有回复”的假象。
 */
export async function runDiscussionTasks<T>(
  items: T[],
  task: (item: T) => Promise<void>,
  onError: (item: T, error: unknown) => void
): Promise<void> {
  for (const item of items) {
    try {
      await task(item);
    } catch (error) {
      onError(item, error);
    }
  }
}

/**
 * 批量修复结果分类：把 batch 结果映射为每个 finding 的 fixed/failed。
 *
 * 必须 batch 整体成功才算 ✅：executeBatchFix 在某个 finding 失败时会提前返回，
 * 此时 commitAndPush 没有执行，appliedFiles 中的文件并未真正推送，
 * 不能因为出现在 appliedFiles 中就标记为已修复。
 */
export function classifyBatchFixItems(
  items: Array<{ file: string; line: number; deleteFile?: boolean }>,
  batchResult: { success: boolean; reason: string; appliedFiles: string[]; deletedFiles: string[] }
): { fixedItems: string[]; failedItems: string[] } {
  const fixedItems: string[] = [];
  const failedItems: string[] = [];
  for (const item of items) {
    const key = `${item.file}:${item.line}`;
    const fixed = item.deleteFile
      ? batchResult.success
      : batchResult.success && batchResult.appliedFiles.includes(item.file);
    if (fixed) {
      fixedItems.push(key);
    } else {
      failedItems.push(`${key} — ${batchResult.reason || '修复失败'}`);
    }
  }
  return { fixedItems, failedItems };
}

/**
 * MaintainerRunner 构造选项
 */
export interface MaintainerRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
}

export class MaintainerRunner extends BaseRoleRunner {
  constructor(options: MaintainerRunnerOptions) {
    super({ llmClient: options.llmClient });
  }

  protected getRole(): 'maintainer' {
    return 'maintainer';
  }

  protected getDefaultSchedule(): string {
    return '*/10 * * * *';
  }

  /**
   * 对单个项目执行 MR 维护轮询
   */
  protected async runProject(project: Project, config: RoleConfig): Promise<void> {
    const maintainerConfig = config as MaintainerConfig;
    if (!project.gitlab) {
      logger.warn({ projectId: project.id }, '项目未配置 GitLab，跳过 Maintainer 轮询');
      return;
    }
    const gitlabConfig = project.gitlab;

    const provider = new GitLabProvider(gitlabConfig);

    const { soul, projectContext } = this.loadRoleContext(project);

    const mcpUrl = process.env.CK_EVEROS_MCP_URL ?? '';
    const baseMemoryContext = {
      appId: 'codekeeper-advance',
      projectId: project.id,
      agentId: 'maintainer',
      userId: 'codekeeper-system',
    };

    const allowedRiskLevels = maintainerConfig.autoFixRiskLevels ?? [
      'LOW',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
    ];
    const maintainerName = maintainerConfig.maintainerName || 'CodeKeeper Maintainer';
    const worktreeManager = new WorktreeManager({
      projectId: project.id,
      rootPath: project.rootPath,
      remoteUrl: buildAuthenticatedRemoteUrl(gitlabConfig),
    });

    const cognitiveDepth = maintainerConfig.cognitiveDepth ?? 'deep';
    const brainOptions = {
      llmClient: this.llmClient,
      allowedRiskLevels,
      soulContent: soul.content || undefined,
      projectContext,
      cognitiveDepth,
      worktreeManager,
    };

    const state = loadState(project);
    state.interactiveThreads ??= {};

    console.log(`[MaintainerRunner] 扫描项目 ${project.name} 的 open MRs...`);
    console.log(
      `[MaintainerRunner] 项目 ${project.name} 使用 filter: ${JSON.stringify(maintainerConfig.filter ?? {})}`
    );
    console.log(
      `[MaintainerRunner] 项目 ${project.name} 允许自动修复的风险等级: ${allowedRiskLevels.join(',')}`
    );

    let mrs: MergeRequest[];
    try {
      mrs = await provider.listOpenMRs(config.filter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerRunner] 列出项目 ${project.name} 的 MR 失败: ${message}`);
      throw error;
    }

    console.log(`[MaintainerRunner] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);
    logMemoryUsage('开始处理项目前');

    // 默认跳过 draft；如果 filter 里显式配置了 Draft=true，则保留 draft MR
    const draftCondition = maintainerConfig.filter?.conditions.find(c => c.field === 'draft');
    const includeDraft = draftCondition?.values.includes('true') ?? false;

    for (const mr of mrs) {
      if (mr.draft && !includeDraft) {
        console.log(`[MaintainerRunner] 跳过 draft MR !${mr.iid}: ${mr.title}`);
        continue;
      }

      console.log(`[MaintainerRunner] 维护 MR !${mr.iid}: ${mr.title}`);

      let allDiscussions: Discussion[];
      let discussions: Discussion[];
      let activeDiscussionIds: Set<string>;
      try {
        const snapshot = await provider.getDiscussionSnapshot(mr.iid);
        allDiscussions = snapshot.all;
        activeDiscussionIds = new Set(snapshot.active.map(discussion => discussion.id));
        discussions = this.includeTrackedDiscussions(
          snapshot.active,
          snapshot.all,
          new Set([
            ...Object.keys(state.maintainerThreadState ?? {}),
            ...Object.keys(state.interactiveThreads ?? {}),
          ])
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerRunner] 获取 MR !${mr.iid} discussions 失败: ${message}`);
        continue;
      }

      const memoryClient = mcpUrl
        ? new MemoryClient({
            mcpUrl,
            context: {
              ...baseMemoryContext,
              sessionId: buildMaintainerMrSessionId(project.id, mr.iid),
            },
          })
        : undefined;
      await memoryClient?.connect().catch(() => undefined);
      const recallPlanner = memoryClient
        ? new RecallPlanner({ llmClient: this.llmClient, memoryClient })
        : undefined;
      const brain = new MaintainerBrain({ ...brainOptions, memoryClient, recallPlanner });
      const actor = new MaintainerActor({
        provider,
        llmClient: this.llmClient,
        worktreeManager,
        brain,
        maintainerName,
        memoryClient,
        recallPlanner,
        checkpoint: () => saveState(project, state, 'maintainer'),
      });

      const reconciliationResults = await this.reconcileTrackedDiscussionDeliveries(
        actor,
        provider,
        mr,
        allDiscussions,
        state
      );
      saveState(project, state, 'maintainer');

      console.log(`[MaintainerRunner] MR !${mr.iid} 原始 discussion 数量: ${discussions.length}`);
      discussions.forEach((d, idx) => {
        console.log(
          `[MaintainerRunner] discussion[${idx}] id=${d.id}, resolvable=${d.resolvable}, resolved=${d.resolved}, notes=${d.notes.length}, firstAuthor=${d.notes[0]?.author ?? 'none'}`
        );
      });

      let currentHeadSha: string | undefined;
      try {
        currentHeadSha = (await provider.getMRShaInfo(mr.iid)).headSha;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[MaintainerRunner] MR !${mr.iid} current HEAD unavailable; stale recheck skipped: ${message}`
        );
      }

      const pendingDiscussions = discussions.filter(d => {
        const reconciliation = reconciliationResults.get(d.id);
        if (reconciliation?.pending) return false;

        const isActive = activeDiscussionIds.has(d.id);
        const headChanged =
          isActive && hasHeadChangedSinceProcessing(d, state, currentHeadSha);
        const pending = isDiscussionPending(d, state) || headChanged;
        if (!isActive && pending && !this.canRecoverOutsideActivityWindow(d, state)) {
          console.log(
            `[MaintainerRunner] discussion ${d.id} 超出最近活动窗口且无待恢复状态，跳过分析`
          );
          return false;
        }
        if (!pending) {
          const processed = state.processedDiscussions?.[d.id];
          console.log(
            `[MaintainerRunner] discussion ${d.id} skipped: resolved=${d.resolved}, resolvable=${d.resolvable}, interactive=${state.interactiveThreads[d.id]?.status ?? 'none'}, processed=${processed ? `${processed.noteCount}/${d.notes.length}` : 'no'}`
          );
        } else if (headChanged) {
          console.log(
            `[MaintainerRunner] discussion ${d.id} has a new MR HEAD; rechecking historical findings`
          );
        }
        return pending;
      });

      console.log(
        `[MaintainerRunner] MR !${mr.iid} pending discussions: ${pendingDiscussions.length}`
      );

      if (pendingDiscussions.length === 0) {
        console.log(`[MaintainerRunner] MR !${mr.iid} has no pending discussions`);
        await memoryClient?.disconnect().catch(() => undefined);
        continue;
      }

      console.log(
        `[MaintainerRunner] MR !${mr.iid} processing ${pendingDiscussions.length} discussions`
      );
      await runDiscussionTasks(
        pendingDiscussions,
        async discussion => {
        console.log(
          `[MaintainerRunner] 开始处理 discussion ${discussion.id}, position=${JSON.stringify(discussion.position)}`
        );
        logMemoryUsage(`处理 discussion ${discussion.id} 前`);
        await this.processDiscussion(
          mr,
          discussion,
          provider,
          brain,
          actor,
          worktreeManager,
          maintainerName,
          state,
          project.rootPath,
          memoryClient,
           cognitiveDepth,
           currentHeadSha
         );
         saveState(project, state, 'maintainer');
         },
        (discussion, error) => {
          // 记忆写入可能已经在异常前完成，因此不能据此推断回复也已成功发布。
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[MaintainerRunner] discussion ${discussion.id} 处理异常，继续处理后续 discussion: ${message}`
          );
          saveState(project, state, 'maintainer');
        }
      );
      await memoryClient?.disconnect().catch(() => undefined);
    }

    saveState(project, state, 'maintainer');
  }

  /**
   * 处理单个 discussion（来自 Reviewer 或人工）。
   *
   * 说明：该方法虽为内部实现细节，但作为核心处理单元直接暴露给单元测试，
   * 避免测试中通过 `as unknown as Record<string, unknown>` 绕过类型系统访问私有成员。
   */
  async processDiscussion(
    mr: MergeRequest,
    discussion: Discussion,
    provider: GitLabProvider,
    brain: MaintainerBrain,
    actor: MaintainerActor,
    worktreeManager: WorktreeManager,
    maintainerName: string,
    state: MrAgentState,
    projectRootPath: string,
    memoryClient?: MemoryClient,
    cognitiveDepth: 'fast' | 'standard' | 'deep' = 'standard',
    currentHeadSha?: string
  ): Promise<void> {
    const recordProcessed = () => {
      state.processedDiscussions ??= {};
      state.processedDiscussions[discussion.id] = {
        noteCount: discussion.notes.length,
        processedAt: Date.now(),
      };
      const threadState = state.maintainerThreadState?.[discussion.id];
      if (threadState) {
        threadState.lastReviewerNoteAt = discussion.notes[0]
          ? getCommentActivityAt(discussion.notes[0])
          : threadState.lastReviewerNoteAt;
        if (currentHeadSha) {
          threadState.lastProcessedHeadSha = currentHeadSha;
        }
      }
    };

    const firstNote = discussion.notes[0];
    if (!firstNote) {
      recordProcessed();
      return;
    }

    const threadState = this.getMaintainerThreadState(state, discussion.id);
    const sourceNoteEdited = getCommentUpdatedAt(firstNote) > (
      threadState.lastReviewerNoteAt > 0
        ? threadState.lastReviewerNoteAt
        : Math.max(
            ...Object.values(threadState.decisions).map(decision => decision.decidedAt),
            threadState.lastSummaryAt ?? 0,
            state.processedDiscussions?.[discussion.id]?.processedAt ?? 0
          )
    );
    const delivery = threadState.delivery;
    const deliveryNoteExists = Boolean(
      delivery &&
        discussion.notes.some(
          note => note.id === delivery.replyNoteId || note.body === delivery.replyBody
        )
    );
    const shouldReconcileDelivery =
      isDiscussionDeliveryPending(delivery) ||
      Boolean(delivery?.replyStatus === 'posted' && !deliveryNoteExists);
    if (shouldReconcileDelivery) {
      const deliveryResult = await this.retryPendingDiscussionDelivery(
        actor,
        provider,
        mr,
        discussion,
        state
      );
      if (deliveryResult?.pending) {
        recordProcessed();
        console.warn(
          `[MaintainerRunner] discussion ${discussion.id} 远端投递仍待重试: ${deliveryResult.error ?? '未知错误'}`
        );
        return;
      }
      if (deliveryResult) {
        if (threadState.delivery?.awaitingReply) {
          this.restoreInteractiveThread(state, discussion.id);
        } else {
          this.clearAwaitingReplyState(state, discussion.id);
          recordProcessed();
          console.log(`[MaintainerRunner] discussion ${discussion.id} 已恢复未完成的远端投递`);
          return;
        }
      }
    } else if (delivery?.replyStatus === 'posted' && delivery.awaitingReply) {
      this.restoreInteractiveThread(state, discussion.id);
    }

    // 如果本 discussion 正在交互式等待 Reviewer 回复，先处理新回复
    const existingThread = state.interactiveThreads?.[discussion.id];
    if (existingThread?.status === 'awaiting-reply') {
      const askedAt = existingThread.askedAt;
      // 只要 discussion 里在提问时间之后还有 Maintainer 发布的 note，就说明状态有效
      const maintainerNotesAfterAsk = discussion.notes.filter(note => {
        if (!isMaintainerAuthoredNote(note.body)) return false;
        return getCommentActivityAt(note) >= askedAt - 1000;
      });

      // 如果 discussion 里已经找不到提问后的 Maintainer note，说明状态已脏，清除后继续处理
      if (maintainerNotesAfterAsk.length === 0) {
        console.warn(
          `[MaintainerRunner] discussion ${discussion.id} 的交互状态已过期，清除后重新处理`
        );
        this.clearAwaitingReplyState(state, discussion.id);
      } else {
        const newReviewerNotes = discussion.notes.filter(note => {
          if (isAgentAuthoredNote(note.body) || isBotAuthor(note.author)) return false;
          return getCommentActivityAt(note) > askedAt;
        });

        if (newReviewerNotes.length === 0) {
          if (Date.now() - askedAt > INTERACTIVE_REPLY_TIMEOUT_MS) {
            // 超时未收到回复：清理交互状态，避免无限等待；
            // 讨论中有人工参与者时留一条收尾说明，纯 Agent 讨论静默清理
            const hasHumanNotes = discussion.notes.some(
              note => !isAgentAuthoredNote(note.body) && !isBotAuthor(note.author)
            );
            if (hasHumanNotes) {
              try {
                const timeoutDays = Math.round(
                  INTERACTIVE_REPLY_TIMEOUT_MS / (24 * 60 * 60 * 1000)
                );
                const timeoutResult = await this.postDiscussionReply(
                  actor,
                  provider,
                  mr,
                  discussion,
                  `⏳ 已超过 ${timeoutDays} 天未收到回复，暂时搁置该问题。如仍需处理，请直接回复本讨论。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`,
                  state
                );
                if (!timeoutResult.replyPosted) {
                  console.warn(
                    `[MaintainerRunner] discussion ${discussion.id} 超时收尾说明待重试: ${timeoutResult.error ?? '未知错误'}`
                  );
                  recordProcessed();
                  return;
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[MaintainerRunner] 发布交互超时收尾说明失败: ${message}`);
                recordProcessed();
                return;
              }
            }
            this.clearAwaitingReplyState(state, discussion.id);
            console.log(
              `[MaintainerRunner] discussion ${discussion.id} 交互式提问超时未回复，已清理等待状态`
            );
          } else {
            console.log(`[MaintainerRunner] discussion ${discussion.id} 等待 Reviewer 回复中`);
          }
          recordProcessed();
          return;
        }

        const interactiveFilePath = existingThread.filePath;
        const interactiveQuestion = existingThread.question;
        this.clearAwaitingReplyState(state, discussion.id);
        try {
          await this.handleInteractiveReply(
            mr,
            discussion,
            brain,
            actor,
            worktreeManager,
            maintainerName,
            state,
            projectRootPath,
            interactiveFilePath
          );
        } catch (error) {
          state.interactiveThreads[discussion.id] = {
            status: 'awaiting-reply',
            askedAt,
            question: interactiveQuestion,
            filePath: interactiveFilePath,
          };
          const currentDelivery = state.maintainerThreadState?.[discussion.id]?.delivery;
          if (currentDelivery) {
            currentDelivery.awaitingReply = true;
            currentDelivery.awaitingReplyAt = askedAt;
            currentDelivery.question = interactiveQuestion;
            currentDelivery.filePath = interactiveFilePath;
            currentDelivery.updatedAt = Date.now();
          }
          throw error;
        }
        recordProcessed();
        return;
      }
    }

    // CI Review 使用结构化解析，避免把规则确认项、优点或折叠区说明混成普通 finding。
    const ciReview = parseStructuredCiReview(firstNote.body, { projectRootPath });
    const reviewCommit = getDiscussionReviewCommit(
      mr,
      discussion,
      firstNote.id,
      state,
      ciReview?.commitSha ?? extractReviewCommit(firstNote.body)
    );

    // 明确的机器统计报告必须在 finding 解析前截断。
    // 否则 Top files 表格会被解析成一批 line:1 的文件级 finding；一旦后续 LLM
    // 保守地判成「非统计报告」，这些计数行就会错误进入修复循环。
    // 混合报告若包含具体 file:line 定位，不会命中此确定性闸门，仍按正常 finding 处理。
    if (!ciReview && this.isClearlyStatisticalReportBody(firstNote.body)) {
      console.log(
        `[MaintainerRunner] discussion ${discussion.id} 结构化识别为纯统计报告，解析前静默跳过`
      );
      threadState.statisticalReport = true;
      recordProcessed();
      return;
    }

    // 先解析 finding，用解析结果区分「纯统计报告」与「含可操作 finding 的混合报告」：
    // 只有完全解析不出可操作 finding 时才可能是纯统计报告；
    // 统计汇总 + reviewer 分析混合的报告，剥离聚合条目后照常处理分析部分。
    let findings = ciReview
      ? ciReview.findings
      : await brain.parseFindings({
          body: firstNote.body,
          position: discussion.position,
          isSummary: firstNote.body.includes('CodeKeeper Advance MR 评审 Agent'),
        });
    const staleFinding = isReviewCommitStale(
      reviewCommit ?? threadState.lastProcessedHeadSha,
      currentHeadSha
    );

    if (ciReview) {
      console.log(
        `[MaintainerRunner] discussion ${discussion.id} 结构化解析 CI Review: findings=${findings.length}, confirmationItems=${ciReview.confirmationItems.length}, round=${ciReview.round ?? 'unknown'}, stale=${staleFinding}`
      );
      if (ciReview.confirmationItems.length > 0) {
        console.log(
          `[MaintainerRunner] discussion ${discussion.id} 跳过 ${ciReview.confirmationItems.length} 个需人工确认的规则扫描项，不进入自动修复/提问流程`
        );
      }
      if (findings.length === 0 && ciReview.confirmationItems.length > 0) {
        threadState.nonFindingAction = 'ignore';
        recordProcessed();
        return;
      }
    }

    // 疑似聚合条目：无具体行号（line === 1）且 message 只是数字/符号，
    // 通常是从统计表（Top files、覆盖率等）里误捞的文件路径行
    const isAggregateLikeFinding = (finding: ReviewFinding): boolean =>
      finding.line === 1 && this.isNonDescriptiveMessage(finding.message);
    const actionableFindings = findings.filter(finding => !isAggregateLikeFinding(finding));

    // 已缓存统计报告标记的重验：能解析出可操作 finding 说明之前误判或报告已更新，清除标记继续处理
    if (threadState.statisticalReport) {
      if (actionableFindings.length === 0) {
        console.log(`[MaintainerRunner] discussion ${discussion.id} 已标记为统计报告，静默跳过`);
        recordProcessed();
        return;
      }
      console.log(
        `[MaintainerRunner] discussion ${discussion.id} 统计报告标记重验发现可操作 finding，清除标记继续处理`
      );
      threadState.statisticalReport = false;
    }

    // 混合报告：剥离聚合条目，只处理可操作 finding
    if (actionableFindings.length > 0 && actionableFindings.length < findings.length) {
      console.log(
        `[MaintainerRunner] discussion ${discussion.id} 剔除 ${findings.length - actionableFindings.length} 个疑似聚合条目，仅处理 ${actionableFindings.length} 个可操作 finding`
      );
      findings = actionableFindings;
    }

    // 纯统计报告闸：解析结果全是聚合条目时，由 LLM 做最终语义判定；确认则缓存并静默跳过
    if (this.looksLikeAggregateFindings(findings)) {
      const statistical = await brain.isStatisticalReport(firstNote.body);
      if (statistical) {
        console.log(
          `[MaintainerRunner] discussion ${discussion.id} 判定为批量统计报告，缓存并静默跳过（${findings.length} 个疑似聚合条目）`
        );
        threadState.statisticalReport = true;
        recordProcessed();
        return;
      }
      console.log(
        `[MaintainerRunner] discussion ${discussion.id} 疑似聚合条目但 LLM 判定非统计报告，继续正常处理`
      );
    }

    // 获取 MR 级上下文，供非 finding 决策和后续单条/批量处理共用
    let mrContext: MrContext | undefined;
    try {
      const diffs = await provider.getMRDiff(mr.iid);
      const diffSummary = diffs
        .map(d => `${d.filePath}: +${d.additions}/-${d.deletions}`)
        .join('\n');
      mrContext = {
        iid: mr.iid,
        title: mr.title,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        description: mr.description,
        diffSummary,
        changedFiles: diffs.map(d => d.filePath),
      };
    } catch {
      console.warn(`[MaintainerRunner] 获取 MR !${mr.iid} diff 失败，继续使用基础上下文`);
    }

    // 如果解析出来的文件无效，使用 position 兜底
    const hasValidFinding =
      findings.length > 0 && findings.every(f => f.file && f.file !== 'unknown' && f.line > 0);

    // 无法从 body 解析，或解析结果无效时，若 position 提供了文件路径，则构造 synthetic finding
    if (findings.length === 0 || !hasValidFinding) {
      const fallbackFile = discussion.position?.newPath ?? discussion.position?.oldPath;
      if (fallbackFile) {
        console.log(
          `[MaintainerRunner] discussion ${discussion.id} 解析结果无效（${JSON.stringify(
            findings.map(f => `${f.file}:${f.line}`)
          )}），使用 position 兜底: ${fallbackFile}`
        );
        findings = [
          {
            severity: 'MEDIUM',
            file: fallbackFile,
            line: discussion.position?.newLine ?? discussion.position?.oldLine ?? 1,
            message: firstNote.body,
            suggestion: firstNote.body,
            autoFixable: false,
          },
        ];
      } else {
        // 正文预检：纯统计报告可能完全解析不出 finding（如覆盖率、指标汇总表），
        // 命中聚合标记时先由 LLM 判定，确认则缓存并静默跳过，不再走非 finding 决策
        if (this.looksLikeAggregateReportBody(firstNote.body)) {
          const statistical = await brain.isStatisticalReport(firstNote.body);
          if (statistical) {
            console.log(
              `[MaintainerRunner] discussion ${discussion.id} 判定为批量统计报告，缓存并静默跳过`
            );
            threadState.statisticalReport = true;
            recordProcessed();
            return;
          }
        }

        // 该讨论已有 Maintainer 回复/提问（且之后没有新的人工 note），但没有任何处理记录
        // （例如旧版本对非 finding 评论只发过轻松回复/提问）：
        // 静默补记处理证据并跳过，避免重复发布轻松回复或重复提问。
        // 若之后有人工新回复，则正常进入 LLM 决策。
        {
          const lastMaintainerNoteAt = discussion.notes
            .filter(note => isMaintainerAuthoredNote(note.body))
            .reduce((max, note) => {
              return Math.max(max, getCommentActivityAt(note));
            }, 0);
          const lastHumanNoteAt = getLastHumanNoteAt(discussion);
          if (
            lastMaintainerNoteAt > 0 &&
            lastMaintainerNoteAt >= lastHumanNoteAt &&
            !sourceNoteEdited
          ) {
            threadState.nonFindingAction = 'ignore';
            console.log(
              `[MaintainerRunner] discussion ${discussion.id} 已有 Maintainer 回复但无处理记录，静默补记并跳过`
            );
            recordProcessed();
            return;
          }
        }

        console.warn(
          `[MaintainerRunner] 无法从 discussion ${discussion.id} 解析 finding，body 前 200 字符: ${firstNote.body.slice(0, 200)}`
        );
        console.warn(
          `[MaintainerRunner] discussion ${discussion.id} 解析结果: ${JSON.stringify(findings)}`
        );

        // 没有可定位的 finding 时，让 Maintainer 自行判断如何处理
        const decision = await brain.decideNonFindingComment({
          body: firstNote.body,
          mrIid: mr.iid,
          userId: firstNote.author,
          mrContext,
        });
        console.log(
          `[MaintainerRunner] discussion ${discussion.id} 非 finding 决策: action=${decision.action}, reason=${decision.reason}`
        );

        const isFirstNoteFromAgent =
          isAgentAuthoredNote(firstNote.body) || isBotAuthor(firstNote.author);

        if (decision.action === 'record') {
          threadState.nonFindingAction = 'record';
          if (memoryClient) {
            try {
              await memoryClient.recordProjectKnowledge([
                {
                  id: `non-finding-record-${mr.iid}-${discussion.id}`,
                  category: decision.memoryCategory ?? 'risk',
                  sourceFiles: [],
                  content: decision.memoryContent?.trim()
                    ? `MR !${mr.iid} 的讨论记录：\n${decision.memoryContent.slice(0, 4000)}`
                    : `MR !${mr.iid} 的讨论记录：\n${firstNote.body.slice(0, 4000)}`,
                  confidence: 'high',
                  createdAt: new Date().toISOString(),
                },
              ]);
              console.log(`[MaintainerRunner] 已把 discussion ${discussion.id} 记录到项目记忆`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                `[MaintainerRunner] 记录 discussion ${discussion.id} 记忆失败: ${message}`
              );
            }
          }
        } else if (decision.action === 'ask') {
          threadState.nonFindingAction = 'ask';
          // 来自 Agent（Reviewer bot / CI 分析等）的非 finding 评论通常是汇总/总结/赞扬，
          // 向其发问没有意义，还会污染 MR，直接静默忽略。
          if (isFirstNoteFromAgent) {
            console.log(
              `[MaintainerRunner] discussion ${discussion.id} 来自 Agent 且无法解析，转为静默忽略`
            );
          } else {
            const question = decision.question?.trim()
              ? decision.question
              : '我没有完全理解这条评论的意图，能否补充一下需要处理的具体文件或修改方式？';
            try {
              const replyResult = await this.postDiscussionReply(
                actor,
                provider,
                mr,
                discussion,
                `${question}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`,
                state
              );
              if (!replyResult.replyPosted) {
                console.warn(
                  `[MaintainerRunner] 回复 discussion ${discussion.id} 待重试: ${replyResult.error ?? '未知错误'}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`[MaintainerRunner] 回复 discussion ${discussion.id} 失败: ${message}`);
            }
          }
        } else {
          threadState.nonFindingAction = 'ignore';
          console.log(`[MaintainerRunner] discussion ${discussion.id} 已忽略: ${decision.reason}`);
          // 对 Agent 发起的汇总/赞扬类非 finding 评论，不发布轻松回复，避免尬回。
          if (decision.replyBody?.trim() && !isFirstNoteFromAgent) {
            try {
              const replyResult = await this.postDiscussionReply(
                actor,
                provider,
                mr,
                discussion,
                `${decision.replyBody}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`,
                state
              );
              if (replyResult.replyPosted) {
                console.log(`[MaintainerRunner] 已向 discussion ${discussion.id} 发布轻松回复`);
              } else {
                console.warn(
                  `[MaintainerRunner] discussion ${discussion.id} 轻松回复待重试: ${replyResult.error ?? '未知错误'}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`[MaintainerRunner] 发布轻松回复失败: ${message}`);
            }
          } else if (isFirstNoteFromAgent) {
            console.log(
              `[MaintainerRunner] discussion ${discussion.id} 来自 Agent，不发布轻松回复`
            );
          }
        }

        recordProcessed();
        return;
      }
    }

    if (findings.length > 0) {
      findings = await brain.enrichFindingsWithCases(findings, mr.iid);
    }

    console.log(
      `[MaintainerRunner] 从 discussion ${discussion.id} 解析到 ${findings.length} 个 finding`
    );

    // 单条 finding：直接交给 Actor 执行决策后的动作
    if (findings.length === 1) {
      const finding = findings[0];
      const key = getFindingKey(finding);

      // 单条 finding 也使用 decision memory，避免已经处理过的 ignore/已修复被重复回复。
      // 只有「人工」新回复才可能改变已有结论；Agent 自动重扫不带新信息，不触发重评估，
      // 这样既避免重复回复，也省下每次重扫都重跑一遍 LLM 的开销。
      const lastHumanNoteAt = getLastHumanNoteAt(discussion);
      const hasNewHumanNote = lastHumanNoteAt > (threadState.lastHumanNoteAt ?? 0);

      const existing = threadState.decisions[key];
      const sourceNoteChanged = Boolean(
        existing &&
          getCommentUpdatedAt(firstNote) >
            (threadState.lastReviewerNoteAt > 0
              ? threadState.lastReviewerNoteAt
              : existing.decidedAt)
      );
      const staleRecheck = await this.recheckStaleFindingIfNeeded(
        brain,
        worktreeManager,
        finding,
        projectRootPath,
        mr.sourceBranch,
        staleFinding,
        lastHumanNoteAt === 0
      );
      if (staleRecheck?.alreadyFixed) {
        const staleDecision = {
          action: 'ignore',
          alreadyFixed: true,
          reason: staleRecheck.reason,
          replyBody: staleRecheck.evidence || staleRecheck.reason,
        } as const;
        threadState.decisions[key] = {
          ...staleDecision,
          failedAttempts: 0,
          decidedAt: Date.now(),
        };
        threadState.lastHumanNoteAt = lastHumanNoteAt;
        await actor.applyDecision(mr, discussion, finding, staleDecision, state);
        console.log(`[MaintainerRunner] stale finding ${key} 已在当前代码中解决，已回复并 resolve`);
        recordProcessed();
        return;
      }
      const needsRetry =
        existing?.action === 'fix' &&
        !existing.fixSucceeded &&
        existing.failedAttempts < MAX_FIX_RETRY_ATTEMPTS;
      const noFixExplanationMissing =
        existing?.action === 'ignore' &&
        !this.hasNoFixExplanationForItems(discussion, [`${finding.file}:${finding.line}`]);
      if (
        existing &&
        !staleFinding &&
        !needsRetry &&
        !hasNewHumanNote &&
        !sourceNoteChanged &&
        !noFixExplanationMissing
      ) {
        console.log(
          `[MaintainerRunner] finding ${key} 已有历史决策且无人工新回复，跳过: action=${existing.action}`
        );
        threadState.lastHumanNoteAt = lastHumanNoteAt;
        recordProcessed();
        return;
      }
      if (
        existing?.action === 'ignore' &&
        noFixExplanationMissing &&
        !staleFinding &&
        !hasNewHumanNote &&
        !sourceNoteChanged
      ) {
        await actor.applyDecision(
          mr,
          discussion,
          finding,
          {
            action: 'ignore',
            alreadyFixed: existing.alreadyFixed,
            reason: existing.reason,
            replyBody: existing.replyBody,
          },
          state
        );
        console.log(`[MaintainerRunner] finding ${key} 的远端无需修复说明缺失，已补发并 resolve`);
        threadState.lastHumanNoteAt = lastHumanNoteAt;
        recordProcessed();
        return;
      }

      const fileContent = await readDiscussionFileContent(
        worktreeManager,
        projectRootPath,
        finding,
        mr.sourceBranch
      );
      if (fileContent === null) {
        console.warn(`[MaintainerRunner] 读取文件 ${finding.file} 失败，跳过`);
        recordProcessed();
        return;
      }

      const decisionContent = staleFinding
        ? await this.readFullFileForStaleDecision(worktreeManager, finding, fileContent)
        : fileContent;
      const decision = await brain.decide({
        finding,
        fileContent: decisionContent,
        originalComment: firstNote.body,
        mrIid: mr.iid,
        userId: firstNote.author,
        mrContext,
        relatedFindings: [],
        staleFinding,
      });
      console.log(
        `[MaintainerRunner] finding ${finding.file}:${finding.line} 决策: action=${decision.action}, reason=${decision.reason}`
      );

      // 人工新回复触发的重评估：若结论与历史一致，不重复回复，仅刷新状态
      if (
        existing &&
        !staleFinding &&
        !needsRetry &&
        decision.action === existing.action &&
        (decision.alreadyFixed ?? false) === (existing.alreadyFixed ?? false)
      ) {
        console.log(
          `[MaintainerRunner] finding ${key} 人工回复后结论未变(${decision.action})，不重复回复`
        );
        existing.decidedAt = Date.now();
        threadState.lastHumanNoteAt = lastHumanNoteAt;
        recordProcessed();
        return;
      }

      const actionResult = normalizeMaintainerActionResult(
        await actor.applyDecision(mr, discussion, finding, decision, state)
      );
      const codeApplied = actionResult.codeApplied;

      // 记录本次决策，用于下次轮询去重
      threadState.decisions[key] = {
        action: decision.action,
        alreadyFixed: decision.alreadyFixed,
        reason: decision.reason,
        replyBody: decision.replyBody,
        question: decision.question,
        deleteFile: decision.deleteFile,
        failedAttempts:
          decision.action === 'fix' && !codeApplied
            ? (staleFinding ? 0 : (existing?.failedAttempts ?? 0)) + 1
            : staleFinding
              ? 0
              : (existing?.failedAttempts ?? 0),
        fixSucceeded: decision.action === 'fix' ? codeApplied : undefined,
        lastFailureReason:
          decision.action === 'fix' && !codeApplied
            ? actionResult.error ?? existing?.lastFailureReason
            : undefined,
        decidedAt: Date.now(),
      };
      threadState.lastHumanNoteAt = lastHumanNoteAt;

      if (
        cognitiveDepth === 'deep' &&
        codeApplied &&
        decision.action === 'fix' &&
        decision.fixDescription
      ) {
        const engine = new CognitiveEngine({ llmClient: this.llmClient, memoryClient });
        await engine.reflect(
          {
            finding,
            fileContent: focusedContextToString(fileContent),
            originalComment: firstNote.body,
            mrContext: mrContext ?? {
              iid: mr.iid,
              title: mr.title,
              sourceBranch: mr.sourceBranch,
              targetBranch: mr.targetBranch,
              description: mr.description,
              diffSummary: '',
              changedFiles: [],
            },
            relatedFindings: [],
            recalledMemories: [],
          },
          'success',
          decision.fixDescription
        );
      }

      recordProcessed();
      return;
    }

    // 多条 finding：先逐条决策，再对需要修复的项做统一规划、一次提交
    const fixedItems: string[] = [];
    const failedItems: string[] = [];
    const askedItems: Array<{ fileLine: string; text: string }> = [];
    const ignoredItems: Array<{ fileLine: string; reason: string }> = [];
    const alreadyFixedItems: Array<{ fileLine: string; reason: string }> = [];

    const fixableItems: Array<{
      finding: ReviewFinding;
      fileContent: string;
      scope?: import('../fix/maintainer-brain.js').MaintainerDecision['scope'];
      deleteFile?: boolean;
    }> = [];

    // 只有「人工」新回复才触发逐条重评估；Agent 自动重扫不清空决策、不重跑 LLM。
    // 结论未变时 summary 内容哈希不变，也不会重复发布。
    const lastHumanNoteAt = getLastHumanNoteAt(discussion);
    const hasNewHumanNote = lastHumanNoteAt > (threadState.lastHumanNoteAt ?? 0);
    threadState.lastHumanNoteAt = lastHumanNoteAt;

    for (const finding of findings) {
      const key = getFindingKey(finding);
      const existing = threadState.decisions[key];
      const sourceNoteChanged = Boolean(
        existing &&
          getCommentUpdatedAt(firstNote) >
            (threadState.lastReviewerNoteAt > 0
              ? threadState.lastReviewerNoteAt
              : existing.decidedAt)
      );
      const needsRetry =
        existing?.action === 'fix' &&
        !existing.fixSucceeded &&
        existing.failedAttempts < MAX_FIX_RETRY_ATTEMPTS;
      const staleRecheck = await this.recheckStaleFindingIfNeeded(
        brain,
        worktreeManager,
        finding,
        projectRootPath,
        mr.sourceBranch,
        staleFinding,
        getLastHumanNoteAt(discussion) === 0
      );
      if (staleRecheck?.alreadyFixed) {
        threadState.decisions[key] = {
          action: 'ignore',
          alreadyFixed: true,
          reason: staleRecheck.reason,
          replyBody: staleRecheck.evidence || staleRecheck.reason,
          failedAttempts: 0,
          decidedAt: Date.now(),
        };
        alreadyFixedItems.push({
          fileLine: key,
          reason: staleRecheck.evidence || staleRecheck.reason,
        });
        console.log(`[MaintainerRunner] stale finding ${key} 已在当前代码中解决，加入汇总说明`);
        continue;
      }
      const shouldReuse =
        existing &&
        !staleFinding &&
        !hasNewHumanNote &&
        !sourceNoteChanged &&
        !needsRetry;

      if (shouldReuse) {
        console.log(`[MaintainerRunner] finding ${key} 复用历史决策: action=${existing.action}`);
        this.applyStoredDecision(existing, finding, {
          fixedItems,
          failedItems,
          askedItems,
          ignoredItems,
          alreadyFixedItems,
          fixableItems,
        });
        continue;
      }

      const focusedContent = await readDiscussionFileContent(
        worktreeManager,
        projectRootPath,
        finding,
        mr.sourceBranch
      );
      if (focusedContent === null) {
        failedItems.push(`${finding.file}:${finding.line} — 读取文件失败`);
        continue;
      }

      const decisionContent = staleFinding
        ? await this.readFullFileForStaleDecision(worktreeManager, finding, focusedContent)
        : focusedContent;
      const decision = await brain.decide({
        finding,
        fileContent: decisionContent,
        originalComment: firstNote.body,
        mrIid: mr.iid,
        userId: firstNote.author,
        mrContext,
        relatedFindings: findings.filter(f => f !== finding),
        staleFinding,
      });
      console.log(
        `[MaintainerRunner] finding ${finding.file}:${finding.line} 决策: action=${decision.action}, reason=${decision.reason}`
      );

      threadState.decisions[key] = {
        action: decision.action,
        alreadyFixed: decision.alreadyFixed,
        reason: decision.reason,
        replyBody: decision.replyBody,
        question: decision.question,
        deleteFile: decision.deleteFile,
        failedAttempts:
          staleFinding || existing?.action !== 'fix' ? 0 : (existing.failedAttempts ?? 0),
        fixSucceeded: staleFinding ? undefined : existing?.fixSucceeded,
        decidedAt: Date.now(),
      };

      if (decision.action === 'ignore') {
        if (decision.alreadyFixed) {
          alreadyFixedItems.push({
            fileLine: `${finding.file}:${finding.line}`,
            reason: decision.replyBody || decision.reason,
          });
        } else {
          ignoredItems.push({
            fileLine: `${finding.file}:${finding.line}`,
            reason: decision.reason,
          });
        }
        continue;
      }

      if (decision.action === 'ask') {
        askedItems.push({
          fileLine: `${finding.file}:${finding.line}`,
          text: decision.question ?? decision.reason,
        });
        continue;
      }

      fixableItems.push({
        finding,
        fileContent: focusedContextToString(focusedContent),
        scope: decision.scope,
        deleteFile: decision.deleteFile,
      });
    }

    if (fixableItems.length > 0) {
      console.log(
        `[MaintainerRunner] 对 discussion ${discussion.id} 的 ${fixableItems.length} 个 finding 进行批量修复`
      );

      const batchResult = await actor.executeBatchFix(
        mr,
        fixableItems.map(item => ({
          finding: item.finding,
          fileContent: item.fileContent,
          deleteFile: item.deleteFile,
        })),
        firstNote.body
      );
      console.log(
        `[MaintainerRunner] 批量修复结果: success=${batchResult.success}, applied=[${batchResult.appliedFiles.join(',')}], deleted=[${batchResult.deletedFiles.join(',')}]`
      );

      // 按 batch 结果更新每条 finding 的决策状态
      const batchAlreadyFixed = batchResult.alreadyFixedItems ?? [];
      for (const item of fixableItems) {
        const key = getFindingKey(item.finding);
        const decision = threadState.decisions[key];
        if (!decision || decision.action !== 'fix') continue;
        const alreadyFixed = batchAlreadyFixed.find(
          entry => entry.file === item.finding.file && entry.line === item.finding.line
        );
        if (alreadyFixed) {
          decision.action = 'ignore';
          decision.alreadyFixed = true;
          decision.reason = alreadyFixed.reason;
          decision.replyBody = alreadyFixed.reason;
          decision.fixSucceeded = undefined;
          decision.lastFailureReason = undefined;
          alreadyFixedItems.push({ fileLine: key, reason: alreadyFixed.reason });
          continue;
        }
        const isFixed = item.deleteFile
          ? batchResult.success && batchResult.deletedFiles.includes(item.finding.file)
          : batchResult.success && batchResult.appliedFiles.includes(item.finding.file);
        if (isFixed) {
          decision.fixSucceeded = true;
          decision.lastFailureReason = undefined;
        } else {
          decision.failedAttempts = (decision.failedAttempts ?? 0) + 1;
          // 记录真实失败原因，供后续复用决策时生成准确的失败汇总
          decision.lastFailureReason = batchResult.reason || '修复失败';
          decision.decidedAt = Date.now();
        }
      }

      if (cognitiveDepth === 'deep' && batchResult.success && memoryClient) {
        const engine = new CognitiveEngine({ llmClient: this.llmClient, memoryClient });
        for (const item of fixableItems) {
          if (item.deleteFile) continue;
          await engine.reflect(
            {
              finding: item.finding,
              fileContent: item.fileContent,
              originalComment: firstNote.body,
              mrContext: mrContext ?? {
                iid: mr.iid,
                title: mr.title,
                sourceBranch: mr.sourceBranch,
                targetBranch: mr.targetBranch,
                description: mr.description,
                diffSummary: '',
                changedFiles: [],
              },
              relatedFindings: findings.filter(f => f !== item.finding),
              recalledMemories: [],
            },
            'success',
            batchResult.reason
          );
        }
      }

      const classified = classifyBatchFixItems(
        fixableItems
          .filter(
            item =>
              !batchAlreadyFixed.some(
                entry => entry.file === item.finding.file && entry.line === item.finding.line
              )
          )
          .map(item => ({
            file: item.finding.file,
            line: item.finding.line,
            deleteFile: item.deleteFile,
          })),
        batchResult
      );
      fixedItems.push(...classified.fixedItems);
      failedItems.push(...classified.failedItems);
    }

    const summaryHash = buildSummaryStateHash(
      fixedItems,
      failedItems,
      askedItems,
      ignoredItems,
      alreadyFixedItems
    );
    const hasResults =
      fixedItems.length > 0 ||
      failedItems.length > 0 ||
      askedItems.length > 0 ||
      ignoredItems.length > 0 ||
      alreadyFixedItems.length > 0;
    const summaryChanged = summaryHash !== threadState.lastSummaryHash;
    const noFixItems = [...ignoredItems, ...alreadyFixedItems];
    const noFixExplanationComplete = this.hasNoFixExplanationForItems(
      discussion,
      noFixItems.map(item => item.fileLine)
    );

    if (hasResults && (summaryChanged || !noFixExplanationComplete)) {
      const summaryResult = await actor.postSummary(
        mr,
        discussion,
        fixedItems,
        failedItems,
        askedItems,
        ignoredItems,
        alreadyFixedItems,
        state
      );
      if (!summaryResult || summaryResult.replyPosted) {
        threadState.lastSummaryHash = summaryHash;
        threadState.lastSummaryAt = Date.now();
      } else {
        console.warn(
          `[MaintainerRunner] discussion ${discussion.id} summary 投递未完成，保留 hash 以便下轮重试: ${summaryResult.error ?? '未知错误'}`
        );
      }
    } else {
      console.log(
        `[MaintainerRunner] discussion ${discussion.id} summary 无变化或无需发布，跳过（hasResults=${hasResults}, changed=${summaryChanged}）`
      );
    }
    recordProcessed();
  }

  /**
   * 处理交互式 discussion 中 Reviewer 的新回复
   */
  private async handleInteractiveReply(
    mr: MergeRequest,
    discussion: Discussion,
    brain: MaintainerBrain,
    actor: MaintainerActor,
    worktreeManager: WorktreeManager,
    maintainerName: string,
    state: MrAgentState,
    projectRootPath: string,
    filePath: string | undefined
  ): Promise<void> {
    if (!filePath) {
      console.warn(
        `[MaintainerRunner] interactive thread ${discussion.id} 缺少 filePath，结束等待状态`
      );
      return;
    }

    const syntheticFinding: ReviewFinding = {
      severity: 'MEDIUM',
      file: filePath,
      line: 1,
      message: '交互式回复上下文',
      suggestion: '',
      autoFixable: true,
    };

    const fileContent = await readDiscussionFileContent(
      worktreeManager,
      projectRootPath,
      syntheticFinding,
      mr.sourceBranch
    );
    if (fileContent === null) {
      throw new Error(`读取交互回复关联文件失败: ${filePath}`);
    }

    const threadNotes = discussion.notes.map(note => ({
      author: note.author,
      body: note.body,
      createdAt: note.createdAt,
    }));

    console.log(`[MaintainerRunner] discussion ${discussion.id} 收到 Reviewer 回复，请求 LLM 决策`);
    const decision = await brain.decideReply({
      filePath,
      fileContent,
      threadNotes,
      maintainerName,
    });
    console.log(`[MaintainerRunner] LLM 决策: action=${decision.action}`);

    const syntheticFindingForApply: ReviewFinding = {
      severity: 'MEDIUM',
      file: filePath,
      line: 1,
      message: decision.fixDescription ?? '根据 Reviewer 回复处理',
      suggestion: decision.fixDescription ?? '根据 Reviewer 回复处理',
      autoFixable: true,
    };

    await actor.applyDecision(mr, discussion, syntheticFindingForApply, decision, state);
  }

  /**
   * 获取/初始化 discussion 级别的 Maintainer 状态
   */
  private async postDiscussionReply(
    actor: MaintainerActor,
    provider: GitLabProvider,
    mr: MergeRequest,
    discussion: Discussion,
    body: string,
    state: MrAgentState,
    resolve = false
  ): Promise<DiscussionDeliveryResult> {
    if (typeof actor.postReply === 'function') {
      return actor.postReply(mr, discussion, body, state, resolve);
    }
    return this.deliverDiscussionReplyDirect(provider, mr, discussion, body, resolve, state);
  }

  private async retryPendingDiscussionDelivery(
    actor: MaintainerActor,
    provider: GitLabProvider,
    mr: MergeRequest,
    discussion: Discussion,
    state: MrAgentState
  ): Promise<DiscussionDeliveryResult | null> {
    if (typeof actor.reconcileDelivery === 'function') {
      return actor.reconcileDelivery(mr, discussion, state);
    }
    const delivery = state.maintainerThreadState?.[discussion.id]?.delivery;
    if (!delivery) return null;
    return this.deliverDiscussionReplyDirect(
      provider,
      mr,
      discussion,
      delivery.replyBody,
      delivery.resolveRequired,
      state
    );
  }

  private async deliverDiscussionReplyDirect(
    provider: GitLabProvider,
    mr: MergeRequest,
    discussion: Discussion,
    body: string,
    resolve: boolean,
    state: MrAgentState
  ): Promise<DiscussionDeliveryResult> {
    const threadState = this.getMaintainerThreadState(state, discussion.id);
    return deliverDiscussionReply({
      provider,
      mr,
      discussion,
      body,
      resolve,
      delivery: threadState.delivery,
      setDelivery: delivery => {
        threadState.delivery = delivery;
      },
      checkpoint: () => undefined,
    });
  }

  private restoreInteractiveThread(state: MrAgentState, discussionId: string): void {
    const threadState = state.maintainerThreadState?.[discussionId];
    const delivery = threadState?.delivery;
    const pendingQuestion = Object.entries(threadState?.decisions ?? {}).find(
      ([, decision]) => decision.action === 'ask' || Boolean(decision.question?.trim())
    );
    const filePath =
      delivery?.filePath ?? pendingQuestion?.[0]?.replace(/:\d+$/, '');
    const question = delivery?.question ?? pendingQuestion?.[1].question;
    if (!filePath || !question) return;

    state.interactiveThreads ??= {};
    state.interactiveThreads[discussionId] = {
      status: 'awaiting-reply',
      askedAt: delivery?.awaitingReplyAt ?? delivery?.updatedAt ?? Date.now(),
      question,
      filePath,
    };
  }

  private clearAwaitingReplyState(state: MrAgentState, discussionId: string): void {
    delete state.interactiveThreads[discussionId];
    const delivery = state.maintainerThreadState?.[discussionId]?.delivery;
    if (!delivery) return;
    delivery.awaitingReply = undefined;
    delivery.awaitingReplyAt = undefined;
    delivery.question = undefined;
    delivery.filePath = undefined;
    delivery.updatedAt = Date.now();
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

  private canRecoverOutsideActivityWindow(
    discussion: Discussion,
    state: MrAgentState
  ): boolean {
    if (state.interactiveThreads[discussion.id]?.status === 'awaiting-reply') return true;

    const threadState = state.maintainerThreadState?.[discussion.id];
    if (!threadState) return false;
    if (isDiscussionDeliveryPending(threadState.delivery)) return true;
    if (threadState.delivery?.awaitingReply) return true;

    const decisions = Object.values(threadState.decisions);
    if (
      decisions.some(
        decision =>
          decision.action === 'fix' &&
          !decision.fixSucceeded &&
          decision.failedAttempts < MAX_FIX_RETRY_ATTEMPTS
      )
    ) {
      return true;
    }

    const ignoredFileLines = Object.entries(threadState.decisions)
      .filter(([, decision]) => decision.action === 'ignore')
      .map(([fileLine]) => fileLine);
    return (
      ignoredFileLines.length === decisions.length &&
      ignoredFileLines.length > 0 &&
      !this.hasNoFixExplanationForItems(discussion, ignoredFileLines)
    );
  }

  private async reconcileTrackedDiscussionDeliveries(
    actor: MaintainerActor,
    provider: GitLabProvider,
    mr: MergeRequest,
    discussions: Discussion[],
    state: MrAgentState
  ): Promise<Map<string, DiscussionDeliveryResult>> {
    const results = new Map<string, DiscussionDeliveryResult>();
    for (const discussion of discussions) {
      const delivery = state.maintainerThreadState?.[discussion.id]?.delivery;
      if (!delivery) continue;
      const replyExists = discussion.notes.some(
        note => note.id === delivery.replyNoteId || note.body === delivery.replyBody
      );
      if (!isDiscussionDeliveryPending(delivery) && replyExists) {
        if (delivery.awaitingReply) this.restoreInteractiveThread(state, discussion.id);
        continue;
      }
      try {
        const result = await this.retryPendingDiscussionDelivery(
          actor,
          provider,
          mr,
          discussion,
          state
        );
        if (!result) continue;
        results.set(discussion.id, result);
        if (result.replyPosted && delivery.awaitingReply) {
          this.restoreInteractiveThread(state, discussion.id);
        }
        if (result.pending) {
          console.warn(
            `[MaintainerRunner] discussion ${discussion.id} 远端投递对账失败: ${result.error ?? '未知错误'}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[MaintainerRunner] discussion ${discussion.id} 远端投递对账异常，继续处理后续 discussion: ${message}`
        );
        results.set(discussion.id, {
          replyPosted: false,
          resolved: false,
          pending: true,
          error: message,
        });
      }
    }
    return results;
  }

  private getMaintainerThreadState(state: MrAgentState, discussionId: string) {
    state.maintainerThreadState ??= {};
    state.maintainerThreadState[discussionId] ??= {
      decisions: {},
      lastReviewerNoteAt: 0,
      lastHumanNoteAt: 0,
    };
    return state.maintainerThreadState[discussionId];
  }

  private async readFullFileForStaleDecision(
    worktreeManager: WorktreeManager,
    finding: ReviewFinding,
    fallback: import('../fix/focused-context-builder.js').FocusedContext
  ): Promise<string | import('../fix/focused-context-builder.js').FocusedContext> {
    try {
      const resolved = await worktreeManager.resolveFilePath(finding.file);
      if (!resolved) return fallback;
      const content = await worktreeManager.readFile(resolved);
      console.log(
        `[MaintainerRunner] stale finding ${finding.file}:${finding.line} 已读取完整文件 path=${resolved} lines=${content.split(/\r?\n/).length} chars=${content.length}`
      );
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MaintainerRunner] unable to load full stale file ${finding.file}: ${message}`
      );
      return fallback;
    }
  }

  private async recheckStaleFindingIfNeeded(
    brain: MaintainerBrain,
    worktreeManager: WorktreeManager,
    finding: ReviewFinding,
    projectRootPath: string,
    sourceBranch: string,
    staleFinding: boolean,
    withoutHumanNotes: boolean
  ): Promise<{ alreadyFixed: boolean; reason: string; evidence?: string } | null> {
    if (!staleFinding || !withoutHumanNotes || typeof brain.recheckAlreadyFixed !== 'function') {
      return null;
    }

    const focusedContent = await readDiscussionFileContent(
      worktreeManager,
      projectRootPath,
      finding,
      sourceBranch
    );
    if (focusedContent === null) {
      try {
        const resolved = await worktreeManager.resolveFilePath(finding.file);
        if (!resolved) {
          return {
            alreadyFixed: true,
            reason: `当前分支已不存在文件 ${finding.file}，旧 finding 不再适用`,
            evidence: `当前分支无法定位 ${finding.file}，该文件已被删除或移动`,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[MaintainerRunner] stale finding ${finding.file}:${finding.line} 路径复核失败: ${message}`
        );
      }
      return null;
    }

    try {
      return await brain.recheckAlreadyFixed(finding);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MaintainerRunner] stale finding ${finding.file}:${finding.line} 当前代码复核失败: ${message}`
      );
      return null;
    }
  }

  /**
   * 轻量预检：从原始正文中识别批量统计/聚合报告。
   *
   * 不同项目、不同工具的统计报告格式差异很大（markdown 表格、空格对齐文本、
   * 纯文本列表等），parseFindings 可能把它们解析成一堆 line:1 的文件级 finding。
   * 这里通过聚合关键词 + 多文件路径快速筛选，命中后再由 LLM 做最终语义判定。
   */
  private looksLikeAggregateReportBody(body: string): boolean {
    const text = body.toLowerCase();
    const hasAggregateMarkers =
      (text.includes('severity') && text.includes('count')) ||
      text.includes('top rules') ||
      text.includes('top files') ||
      text.includes('error count') ||
      text.includes('warning count') ||
      text.includes('total errors') ||
      text.includes('total warnings');
    if (!hasAggregateMarkers) return false;
    // 至少包含多个文件路径，才像批量统计表
    const fileMatches = body.match(/\b[\w\-./]+\.[a-zA-Z0-9]+\b/g) ?? [];
    return fileMatches.length >= 3;
  }

  /**
   * 确定性识别纯统计报告，避免把机器生成的排名表交给 finding 解析器。
   *
   * 判定刻意保持严格：必须同时具备多组统计区块、至少两个仅含数字指标的文件行，
   * 且正文中不存在具体 file:line 定位。无法确定的格式仍交给原有 LLM 语义判定。
   */
  private isClearlyStatisticalReportBody(body: string): boolean {
    const normalized = body
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_]/g, '')
      .replace(/\r/g, '');
    const lower = normalized.toLowerCase();

    // 混合报告中只要存在具体行号，就不能在解析前整体跳过。
    if (/\b[\w@\-./]+\.[a-zA-Z0-9]+:\d+\b/.test(normalized)) return false;

    const hasSeveritySummary =
      (lower.includes('severity') && lower.includes('count')) ||
      (lower.includes('严重程度') && (lower.includes('数量') || lower.includes('计数')));
    const hasRuleRanking =
      lower.includes('top rules') ||
      lower.includes('rule ranking') ||
      lower.includes('规则排行') ||
      lower.includes('规则排名');
    const hasFileRanking =
      lower.includes('top files') ||
      lower.includes('file ranking') ||
      lower.includes('文件排行') ||
      lower.includes('文件排名');
    const aggregateSectionCount = [hasSeveritySummary, hasRuleRanking, hasFileRanking].filter(
      Boolean
    ).length;
    if (aggregateSectionCount < 2 || !hasFileRanking) return false;

    const hasReportTitle = normalized
      .split('\n')
      .map(line => line.trim().replace(/^#+\s*/, ''))
      .some(line => /(?:report|summary|overview|报告|汇总)$/i.test(line));
    if (!hasReportTitle && aggregateSectionCount < 3) return false;

    const fileRowPattern = /^\|?\s*([\w@\-./]+\.[a-zA-Z0-9]+)\s*(.*?)\s*\|?$/;
    const numericPayloadPattern = /^[\s|+\-.,%0-9]+$/;
    let numericFileRows = 0;

    for (const rawLine of normalized.split('\n')) {
      const line = rawLine.trim();
      if (!line || /^\|?\s*:?-{3,}/.test(line)) continue;
      const match = line.match(fileRowPattern);
      if (!match) continue;

      const payload = match[2].trim();
      if (!payload) continue;
      if (!numericPayloadPattern.test(payload)) return false;
      numericFileRows += 1;
    }

    return numericFileRows >= 2;
  }

  /**
   * 轻量预筛：解析出的 finding 是否像是从统计/汇总表（如 lint Top files、覆盖率表）里误捞出来的。
   *
   * 这类 finding 的特征：
   * - 数量 ≥ 2；
   * - 所有 finding 都没有具体行号（line === 1），说明原表只给了文件路径；
   * - message 里既没有中文，也没有 2 个以上字母组成的单词，只是数字/符号/百分比等数据。
   *
   * 命中后再由 LLM 做最终语义判定，避免把真正的可操作文件清单误当成统计报告。
   */
  private looksLikeAggregateFindings(findings: ReviewFinding[]): boolean {
    if (findings.length < 2) return false;
    const result = findings.every(
      finding => finding.line === 1 && this.isNonDescriptiveMessage(finding.message)
    );
    if (result) {
      console.log(
        `[MaintainerRunner] 解析结果疑似聚合条目（${findings.length} 个 line:1 且 message 无描述），触发 LLM 统计报告判定`
      );
    }
    return result;
  }

  /**
   * message 是否缺乏自然语言描述，只是计数/百分比等数据。
   */
  private isNonDescriptiveMessage(message: string): boolean {
    const text = (message ?? '').trim();
    if (!text) return true;
    // 含中文 → 是描述
    if (/[一-龥]/.test(text)) return false;
    // 含字母单词（≥2 个字母） → 是描述
    if (/[a-zA-Z]{2,}/.test(text)) return false;
    return true;
  }

  /**
   * 复用历史决策，把结果分类到对应的汇总列表
   */
  private applyStoredDecision(
    decision: import('./shared/state-utils.js').MaintainerFindingDecision,
    finding: ReviewFinding,
    buckets: {
      fixedItems: string[];
      failedItems: string[];
      askedItems: Array<{ fileLine: string; text: string }>;
      ignoredItems: Array<{ fileLine: string; reason: string }>;
      alreadyFixedItems: Array<{ fileLine: string; reason: string }>;
      fixableItems: Array<{
        finding: ReviewFinding;
        fileContent: string;
        scope?: import('../fix/maintainer-brain.js').MaintainerDecision['scope'];
        deleteFile?: boolean;
      }>;
    }
  ): void {
    const fileLine = `${finding.file}:${finding.line}`;
    switch (decision.action) {
      case 'ignore': {
        if (decision.alreadyFixed) {
          buckets.alreadyFixedItems.push({
            fileLine,
            reason: decision.replyBody || decision.reason,
          });
        } else {
          buckets.ignoredItems.push({ fileLine, reason: decision.reason });
        }
        break;
      }
      case 'ask': {
        buckets.askedItems.push({
          fileLine,
          text: decision.question || decision.replyBody || decision.reason,
        });
        break;
      }
      case 'fix': {
        if (decision.fixSucceeded) {
          buckets.fixedItems.push(fileLine);
        } else if (decision.failedAttempts >= MAX_FIX_RETRY_ATTEMPTS) {
          // 展示真实失败原因；缺失时退化为中性描述，
          // 避免把当初的决策理由（reason）误当失败原因展示
          buckets.failedItems.push(
            `${fileLine} — ${decision.lastFailureReason ?? '多次尝试修复未成功'}`
          );
        } else {
          // 理论上 needsRetry 才会走到这里，保留为可修复项
          buckets.fixableItems.push({
            finding,
            fileContent: '',
            deleteFile: decision.deleteFile,
          });
        }
        break;
      }
    }
  }

  /** 检查远端 discussion 是否已包含当前无需修复项的逐项说明。 */
  private hasNoFixExplanationForItems(discussion: Discussion, fileLines: string[]): boolean {
    if (fileLines.length === 0) return true;
    const notes = discussion.notes.filter(note => isMaintainerNoFixExplanationNote(note.body));
    if (notes.length === 0) return false;
    if (fileLines.length === 1) return true;
    return fileLines.every(fileLine => notes.some(note => note.body.includes(fileLine)));
  }
}
