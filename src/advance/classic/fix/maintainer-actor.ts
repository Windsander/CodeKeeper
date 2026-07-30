import type { GitLabProvider } from '../provider/gitlab-provider.js';
import type { MergeRequest, ReviewFinding, Discussion, CiFailureReport } from '../provider/types.js';
import type { LlmClient } from '../../llm/client.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { MaintainerBrain, MaintainerDecision } from './maintainer-brain.js';
import type { CognitiveDecision } from './cognitive-types.js';
import type { MrAgentState } from '../runners/shared/state-utils.js';
import type { IMemoryClient } from '../memory/types.js';
import type { RecallPlanner } from '../memory/recall-planner.js';
import type { DiscussionDeliveryResult } from '../runners/shared/discussion-delivery.js';
import { extractFileCandidatesFromTrace } from '../runners/shared/mr-lifecycle.js';
import type { MrLifecycleMetrics } from '../runners/shared/mr-lifecycle.js';
import {
  deliverDiscussionReply,
  isDiscussionDeliveryPending,
} from '../runners/shared/discussion-delivery.js';
import { FixToolLoop } from './fix-tool-loop.js';
import { formatAgentFooter, MAINTAINER_ROLE_LABEL } from '../runners/shared/review-utils.js';
import { basename } from 'node:path';
import { defaultPromptLoader } from '../../llm/prompts/loader.js';
import {
  classifyCommitFailure,
  detectCommitConvention,
  distillCommitFailure,
  extractCommitRejectionSection,
  stripAnsiCodes,
  buildDefaultFixMessage as pipelineBuildDefaultFixMessage,
  buildDefaultBatchMessage as pipelineBuildDefaultBatchMessage,
  buildDefaultDeleteMessage,
} from './commit-pipeline.js';
import { isSelfAnswerableQuestion } from './ask-gate.js';

// 兼容既有引用（含测试）：从本模块再导出，实现统一收敛到 commit-pipeline
export { stripAnsiCodes, extractCommitRejectionSection };

export interface MaintainerActorOptions {
  /** GitLab API 提供者 */
  provider: GitLabProvider;
  /** LLM 客户端 */
  llmClient: LlmClient;
  /** worktree 管理器 */
  worktreeManager: WorktreeManager;
  /** Maintainer 大脑，用于环境准备等二次决策 */
  brain: MaintainerBrain;
  /** Maintainer Agent 显示名称，用于评论签名 */
  maintainerName: string;
  /** 可选的记忆客户端 */
  memoryClient?: IMemoryClient;
  /** 可选的记忆查询规划器 */
  recallPlanner?: RecallPlanner;
  /** 远端副作用状态变化后的即时 checkpoint */
  checkpoint?: () => void;
  /** 可选的 M 系列过程指标计数器（M1/M2/M3/M5/M6 由本类自增） */
  metrics?: MrLifecycleMetrics;
}

export interface MaintainerActionResult {
  codeApplied: boolean;
  replyPosted: boolean;
  resolved: boolean;
  awaitingReply: boolean;
  pending: boolean;
  error?: string;
}

/**
 * MaintainerActor
 *
 * 负责把 MaintainerBrain 的决策转化为实际行动：
 * - fix：直接驱动 FixToolLoop 在 worktree 中修复、校验，成功后统一 commitAndPush。
 * - ask：在 discussion 下发表评论提问，记录交互状态。
 * - ignore：回复说明忽略原因。
 *
 * 所有 worktree 修改/执行/验证都在本类内协调完成。
 */
export class MaintainerActor {
  /** 项目提交信息规范缓存（实例级，避免每次提交都召回记忆） */
  private commitConvention?: string;
  private commitConventionLoaded = false;

  constructor(private readonly options: MaintainerActorOptions) {}

  /** 自增一个 M 系列过程指标（metrics 未注入时静默跳过） */
  private incrMetric(
    key:
      | 'readOnlyFinalActingRounds'
      | 'commitFirstTryPasses'
      | 'commitFirstTryRejections'
      | 'askGateInterceptions'
      | 'hookFailureReflows'
  ): void {
    const m = this.options.metrics;
    if (m) {
      m[key] = (m[key] ?? 0) + 1;
    }
  }

  /** loop.run() 之后检查是否动用了最后一轮行动机会，计入 M1 */
  private trackFinalActingRound(loop: FixToolLoop): void {
    if (loop.wasFinalActingRoundUsed()) {
      this.incrMetric('readOnlyFinalActingRounds');
    }
  }

  /**
   * 对单条 finding/discussion 应用决策
   */
  async applyDecision(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    decision: MaintainerDecision,
    state: MrAgentState
  ): Promise<MaintainerActionResult> {
    switch (decision.action) {
      case 'fix': {
        if (decision.deleteFile) {
          const result = await this.executeDeleteFileFix(mr, discussion, finding, decision, state);
          if (!result.codeApplied) {
            const question = defaultPromptLoader.load('maintainer-delete-failed-ask', {
              file: finding.file,
            });
            decision.question = question;
            const askResult = await this.ask(mr, discussion, question, finding.file, state);
            return this.mergeActionResults(result, askResult, false);
          }
          return result;
        }
        const result = await this.executeFix(mr, discussion, finding, decision, state);
        if (!result.codeApplied) {
          const question = defaultPromptLoader.load('maintainer-fix-failed-ask', {
            fileLine: `${finding.file}:${finding.line}`,
          });
          decision.question = question;
          const askResult = await this.ask(mr, discussion, question, finding.file, state);
          return this.mergeActionResults(result, askResult, false);
        }
        return result;
      }
      case 'ask': {
        const question = decision.question ?? defaultPromptLoader.load('maintainer-ask-clarify');
        // L2 ask 门禁：仓库内可自查的索问不出现在 MR 上，转为修复自查；
        // 自查失败才退回提问，且使用修复失败模板而非原索问。
        if (decision.question && isSelfAnswerableQuestion(decision.question)) {
          this.incrMetric('askGateInterceptions');
          console.log(
            `[MaintainerActor] ask 门禁拦截仓库内可自查的索问，转为修复自查: ${decision.question}`
          );
          decision.action = 'fix';
          decision.fixDescription = [
            decision.fixDescription,
            `原提问被框架门禁拦截（所索信息在仓库内可自行查阅，禁止向 Reviewer 索要文件内容/代码片段）：${decision.question}`,
          ]
            .filter(Boolean)
            .join('\n');
          const result = await this.executeFix(mr, discussion, finding, decision, state);
          if (!result.codeApplied) {
            const fallbackQuestion = defaultPromptLoader.load('maintainer-fix-failed-ask', {
              fileLine: `${finding.file}:${finding.line}`,
            });
            decision.question = fallbackQuestion;
            const askResult = await this.ask(mr, discussion, fallbackQuestion, finding.file, state);
            return this.mergeActionResults(result, askResult, false);
          }
          return result;
        }
        return this.ask(mr, discussion, question, finding.file, state);
      }
      case 'ignore': {
        return this.ignore(mr, discussion, decision.reason ?? '无需处理', decision, state);
      }
    }
  }

  /**
   * 对汇总评论或多 finding 发布统一回复
   */
  async postSummary(
    mr: MergeRequest,
    discussion: Discussion,
    fixedItems: string[],
    failedItems: string[],
    askedItems: Array<{ fileLine: string; text: string }>,
    ignoredItems: Array<{ fileLine: string; reason: string }>,
    alreadyFixedItems: Array<{ fileLine: string; reason: string }>,
    state: MrAgentState
  ): Promise<DiscussionDeliveryResult> {
    const sections: string[] = [];

    if (fixedItems.length > 0) {
      sections.push(`✅ 已自动修复并推送：\n${fixedItems.map(item => `- ${item}`).join('\n')}`);
    }
    if (alreadyFixedItems.length > 0) {
      sections.push(
        `✅ 已修复（无需重复修改）：\n${alreadyFixedItems.map(item => `- ${item.fileLine}: ${item.reason}`).join('\n')}`
      );
    }
    if (failedItems.length > 0) {
      sections.push(`⏸️ 尝试修复未成功：\n${failedItems.map(item => `- ${item}`).join('\n')}`);
    }
    if (askedItems.length > 0) {
      sections.push(
        `❓ 需要 Reviewer 澄清：\n${askedItems.map(item => `- ${item.fileLine}: ${item.text}`).join('\n')}`
      );
    }
    if (ignoredItems.length > 0) {
      sections.push(
        `📝 已忽略：\n${ignoredItems.map(item => `- ${item.fileLine}: ${item.reason}`).join('\n')}`
      );
    }

    if (sections.length === 0) {
      console.log(`[MaintainerActor] discussion ${discussion.id} 没有任何处理结果，跳过回复`);
      return { replyPosted: false, resolved: false, pending: false };
    }

    const body = `${sections.join('\n\n')}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`;
    console.log(
      `[MaintainerActor] discussion ${discussion.id} 汇总回复 counts=fixed:${fixedItems.length},alreadyFixed:${alreadyFixedItems.length},failed:${failedItems.length},asked:${askedItems.length},ignored:${ignoredItems.length}`
    );

    // 已修复、已确认无需重复修改、已忽略都属于终态；无失败/待澄清项时 resolve。
    const completedItems = fixedItems.length + alreadyFixedItems.length + ignoredItems.length;
    const shouldResolve = completedItems > 0 && failedItems.length === 0 && askedItems.length === 0;
    const pendingQuestion = askedItems[0];
    const result = await this.deliverReply(
      mr,
      discussion,
      body,
      shouldResolve,
      state,
      pendingQuestion
        ? { question: pendingQuestion.text, filePath: pendingQuestion.fileLine.split(':')[0] }
        : undefined
    );

    if (result.replyPosted && askedItems.length > 0) {
      this.setAwaitingReply(
        state,
        discussion.id,
        askedItems[0].text,
        askedItems[0].fileLine,
        state.maintainerThreadState?.[discussion.id]?.delivery?.awaitingReplyAt
      );
      this.options.checkpoint?.();
      console.log(`[MaintainerActor] 汇总 discussion ${discussion.id} 有待澄清项，等待回复`);
    } else if (result.resolved) {
      console.log(`[MaintainerActor] 汇总 discussion ${discussion.id} 已全部处理并 resolve`);
    }

    return result;
  }

  /** 发布非 finding 场景或超时收尾所需的普通 discussion 回复。 */
  async postReply(
    mr: MergeRequest,
    discussion: Discussion,
    body: string,
    state: MrAgentState,
    resolve = false
  ): Promise<DiscussionDeliveryResult> {
    return this.deliverReply(mr, discussion, body, resolve, state);
  }

  /** 恢复上一次已记录但尚未完成的远端投递。 */
  async retryPendingDelivery(
    mr: MergeRequest,
    discussion: Discussion,
    state: MrAgentState
  ): Promise<DiscussionDeliveryResult | null> {
    const threadState = state.maintainerThreadState?.[discussion.id];
    if (!isDiscussionDeliveryPending(threadState?.delivery)) return null;
    const delivery = threadState?.delivery;
    if (!delivery) return null;
    return this.deliverReply(
      mr,
      discussion,
      delivery.replyBody,
      delivery.resolveRequired,
      state
    );
  }

  /** 对账任意已记录投递，包括远端可能已被删除的完成态回复。 */
  async reconcileDelivery(
    mr: MergeRequest,
    discussion: Discussion,
    state: MrAgentState
  ): Promise<DiscussionDeliveryResult | null> {
    const delivery = state.maintainerThreadState?.[discussion.id]?.delivery;
    if (!delivery) return null;
    return this.deliverReply(
      mr,
      discussion,
      delivery.replyBody,
      delivery.resolveRequired,
      state
    );
  }

  /**
   * 批量执行同一条 discussion 的多个 finding，统一准备 worktree、单次提交
   */
  async executeBatchFix(
    mr: MergeRequest,
    fixableItems: Array<{
      finding: ReviewFinding;
      fileContent: string;
      deleteFile?: boolean;
    }>,
    originalComment: string
  ): Promise<{
    success: boolean;
    reason: string;
    appliedFiles: string[];
    deletedFiles: string[];
    alreadyFixedItems: Array<{ file: string; line: number; reason: string }>;
  }> {
    console.log(`[MaintainerActor] 开始批量修复，${fixableItems.length} 个 finding`);

    try {
      console.log(`[MaintainerActor] 阶段=worktree 准备/更新 worktree`);
      await this.options.worktreeManager.ensureWorktree();
      console.log(`[MaintainerActor] 阶段=checkout 切换到 source branch: ${mr.sourceBranch}`);
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);
      console.log(`[MaintainerActor] 阶段=prepare 准备运行环境`);
      await this.options.worktreeManager.prepareEnvironment();

      const appliedFiles = new Set<string>();
      const deletedFiles = new Set<string>();
      const alreadyFixedItems: Array<{ file: string; line: number; reason: string }> = [];

      for (const item of fixableItems) {
        const { finding } = item;
        if (item.deleteFile) {
          console.log(`[MaintainerActor] 批量修复中删除文件: ${finding.file}`);
          const resolved = await this.options.worktreeManager.resolveFilePath(finding.file);
          if (resolved) {
            await this.options.worktreeManager.removeFile(resolved);
            deletedFiles.add(finding.file);
          }
          continue;
        }

        const loop = new FixToolLoop({
          llmClient: this.options.llmClient,
          worktreeManager: this.options.worktreeManager,
          finding,
          mr,
          memoryClient: this.options.memoryClient,
          recallPlanner: this.options.recallPlanner,
          extraSystemPrompt: `这是同一条 discussion 中的批量修复任务之一。原始评论：\n${originalComment}`,
          recheckAlreadyFixed: () => this.options.brain.recheckAlreadyFixed(finding),
        });

        const result = await loop.run();
        this.trackFinalActingRound(loop);
        console.log(
          `[MaintainerActor] finding ${finding.file}:${finding.line} 修复结果: success=${result.success}, reason=${result.reason}`
        );

        if (result.alreadyFixed) {
          alreadyFixedItems.push({
            file: finding.file,
            line: finding.line,
            reason: result.evidence || result.reason,
          });
          continue;
        }

        if (!result.success) {
          await this.recordFixOutcome(mr.iid, finding, false, result.reason);
          return {
            success: false,
            reason: result.reason,
            appliedFiles: Array.from(appliedFiles),
            deletedFiles: Array.from(deletedFiles),
            alreadyFixedItems,
          };
        }

        for (const f of loop.getAppliedFiles()) {
          appliedFiles.add(f);
        }
        for (const f of loop.getDeletedFiles()) {
          deletedFiles.add(f);
        }
      }

      if (appliedFiles.size === 0 && deletedFiles.size === 0 && alreadyFixedItems.length === 0) {
        return {
          success: false,
          reason: '没有文件被修改或删除',
          appliedFiles: [],
          deletedFiles: [],
          alreadyFixedItems: [],
        };
      }

      const changeDescription = [
        appliedFiles.size > 0
          ? `修改文件：\n${Array.from(appliedFiles)
              .map(f => `- ${f}`)
              .join('\n')}`
          : '',
        deletedFiles.size > 0
          ? `删除文件：\n${Array.from(deletedFiles)
              .map(f => `- ${f}`)
              .join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (appliedFiles.size > 0 || deletedFiles.size > 0) {
        console.log(`[MaintainerActor] 阶段=commit-push 批量提交到分支: ${mr.sourceBranch}`);
        const baseFinding = fixableItems[0].finding;
        await this.commitWithConventionRetry(
          mr.sourceBranch,
          changeDescription,
          () => buildDefaultBatchMessage(Array.from(appliedFiles), Array.from(deletedFiles)),
          distilledFailure =>
            this.reflowAfterHookFailure(mr, baseFinding, distilledFailure, originalComment)
        );
      }

      return {
        success: true,
        reason:
          appliedFiles.size > 0 || deletedFiles.size > 0
            ? '批量修复已推送至 source branch'
            : '所有 finding 在当前代码中均已修复，无需提交',
        appliedFiles: Array.from(appliedFiles),
        deletedFiles: Array.from(deletedFiles),
        alreadyFixedItems,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] 批量修复异常: ${reason}`);
      return { success: false, reason, appliedFiles: [], deletedFiles: [], alreadyFixedItems: [] };
    }
  }

  async executeFix(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    decision: MaintainerDecision,
    state: MrAgentState
  ): Promise<MaintainerActionResult> {
    const syntheticFinding: ReviewFinding = {
      ...finding,
      autoFixable: true,
    };
    const fixGuidance = decision.fixDescription?.trim();
    const extraSystemPrompt = fixGuidance
      ? [
          'MaintainerBrain 提供了以下补充修复方向。它只是实现提示，不能替代或覆盖 Reviewer 的原始 finding：',
          fixGuidance,
          '请始终以 Reviewer 原始问题、目标文件和建议为准，结合当前代码验证该方向是否完整。',
        ].join('\n')
      : undefined;

    console.log(`[MaintainerActor] 执行修复: ${finding.file}:${finding.line}`);

    try {
      console.log(`[MaintainerActor] 阶段=worktree 准备/更新 worktree`);
      await this.options.worktreeManager.ensureWorktree();

      console.log(`[MaintainerActor] 阶段=checkout 切换到 source branch: ${mr.sourceBranch}`);
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);

      console.log(`[MaintainerActor] 阶段=prepare 准备运行环境`);
      await this.options.worktreeManager.prepareEnvironment();

      const loop = new FixToolLoop({
        llmClient: this.options.llmClient,
        worktreeManager: this.options.worktreeManager,
        finding: syntheticFinding,
        mr,
        memoryClient: this.options.memoryClient,
        recallPlanner: this.options.recallPlanner,
        extraSystemPrompt,
        recheckAlreadyFixed: () => this.options.brain.recheckAlreadyFixed(finding),
      });

      const fixResult = await loop.run();
      this.trackFinalActingRound(loop);
      console.log(
        `[MaintainerActor] 修复结果: success=${fixResult.success}, reason=${fixResult.reason}`
      );

      if (fixResult.alreadyFixed) {
        await this.recordFixOutcome(mr.iid, finding, true, `already-fixed: ${fixResult.reason}`);
        decision.action = 'ignore';
        decision.alreadyFixed = true;
        decision.reason = fixResult.reason;
        decision.replyBody = fixResult.evidence || fixResult.reason;
        const delivery = await this.ignore(mr, discussion, decision.reason, decision, state);
        return this.withDeliveryResult(true, delivery);
      }

      if (!fixResult.success) {
        await this.recordFixOutcome(mr.iid, finding, false, fixResult.reason);
        return this.emptyActionResult(false, fixResult.reason);
      }

      console.log(`[MaintainerActor] 阶段=commit-push 提交并推送修复到分支: ${mr.sourceBranch}`);
      await this.commitWithConventionRetry(
        mr.sourceBranch,
        `问题: ${finding.message}\n规则: ${finding.ruleId ?? 'N/A'}\n文件: ${finding.file}:${finding.line}`,
        () => buildDefaultFixMessage(finding),
        distilledFailure =>
          this.reflowAfterHookFailure(mr, syntheticFinding, distilledFailure, extraSystemPrompt)
      );

      const cognitive = decision as CognitiveDecision;
      const reasoningSection = cognitive.reasoning
        ? `\n\n**问题分析**\n${cognitive.analysis ?? '未提供'}\n\n**考虑过的方案**\n${cognitive.consideredOptions?.map((o: string) => `- ${o}`).join('\n') ?? '无'}\n\n**最终决策**\n${cognitive.reasoning}`
        : '';
      const delivery = await this.deliverReply(
        mr,
        discussion,
        `✅ ${this.options.maintainerName} 已根据 Reviewer 的意见自动修复并推送至本分支。${reasoningSection}\n\n请 Reviewer 复核变更。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`,
        true,
        state
      );
      if (delivery.resolved) {
        console.log(`[MaintainerActor] 已修复并 resolve discussion ${discussion.id}`);
      }
      await this.recordFixOutcome(mr.iid, finding, true, '修复已推送并回复');
      return this.withDeliveryResult(true, delivery);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] 修复异常: ${reason}`);
      await this.recordFixOutcome(mr.iid, finding, false, reason);
      return this.emptyActionResult(false, reason);
    }
  }

  /**
   * 执行文件删除修复：Reviewer 指出某文件不应出现在 MR 中时，
   * 在 worktree 中删除该文件并提交推送。
   */
  private async executeDeleteFileFix(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    decision: MaintainerDecision,
    state: MrAgentState
  ): Promise<MaintainerActionResult> {
    console.log(`[MaintainerActor] 执行删除文件修复: ${finding.file}`);

    try {
      console.log(`[MaintainerActor] 阶段=worktree 准备/更新 worktree`);
      await this.options.worktreeManager.ensureWorktree();

      console.log(`[MaintainerActor] 阶段=checkout 切换到 source branch: ${mr.sourceBranch}`);
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);

      console.log(`[MaintainerActor] 阶段=prepare 准备运行环境`);
      await this.options.worktreeManager.prepareEnvironment();

      const resolvedPath = await this.options.worktreeManager.resolveFilePath(finding.file);
      if (!resolvedPath) {
        console.warn(`[MaintainerActor] 无法解析文件路径: ${finding.file}`);
        return this.emptyActionResult(false, `无法解析文件路径: ${finding.file}`);
      }

      console.log(`[MaintainerActor] 阶段=delete 删除文件: ${resolvedPath}`);
      await this.options.worktreeManager.removeFile(resolvedPath);

      const changeDescription = `Reviewer 指出文件 ${finding.file} 不应上传，已从 MR 中删除。`;
      console.log(`[MaintainerActor] 阶段=commit-push 提交删除到分支: ${mr.sourceBranch}`);
      await this.commitWithConventionRetry(
        mr.sourceBranch,
        changeDescription,
        () => buildDefaultDeleteMessage(basename(finding.file)),
        distilledFailure => this.reflowAfterHookFailure(mr, finding, distilledFailure)
      );

      const cognitive = decision as CognitiveDecision;
      const reasoningSection = cognitive.reasoning
        ? `\n\n**问题分析**\n${cognitive.analysis ?? '未提供'}\n\n**考虑过的方案**\n${cognitive.consideredOptions?.map((o: string) => `- ${o}`).join('\n') ?? '无'}\n\n**最终决策**\n${cognitive.reasoning}`
        : '';
      const delivery = await this.deliverReply(
        mr,
        discussion,
        `✅ ${this.options.maintainerName} 已根据 Reviewer 的意见删除文件 \`${finding.file}\` 并推送至本分支。${reasoningSection}\n\n请 Reviewer 复核变更。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`,
        true,
        state
      );
      if (delivery.resolved) {
        console.log(`[MaintainerActor] 已删除文件并 resolve discussion ${discussion.id}`);
      }
      return this.withDeliveryResult(true, delivery);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] 删除文件修复异常: ${reason}`);
      return this.emptyActionResult(false, reason);
    }
  }

  private async ask(
    mr: MergeRequest,
    discussion: Discussion,
    question: string,
    filePath: string,
    state: MrAgentState
  ): Promise<MaintainerActionResult> {
    const result = await this.deliverReply(
      mr,
      discussion,
      `${question}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`,
      false,
      state,
      { question, filePath }
    );
    if (result.replyPosted) {
      this.setAwaitingReply(
        state,
        discussion.id,
        question,
        filePath,
        state.maintainerThreadState?.[discussion.id]?.delivery?.awaitingReplyAt
      );
      this.options.checkpoint?.();
      console.log(`[MaintainerActor] 已在 discussion ${discussion.id} 提出澄清问题`);
    }
    return this.withDeliveryResult(false, result, result.replyPosted);
  }

  private async ignore(
    mr: MergeRequest,
    discussion: Discussion,
    reason: string,
    decision: MaintainerDecision,
    state: MrAgentState
  ): Promise<MaintainerActionResult> {
    const { maintainerName } = this.options;
    const isAlreadyFixed = decision.alreadyFixed === true;
    const body = isAlreadyFixed
      ? defaultPromptLoader.load('maintainer-already-fixed-reply', {
          maintainerName,
          replyBody: decision.replyBody || reason,
        }) + `\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`
      : defaultPromptLoader.load('maintainer-ignore-reply', {
          maintainerName,
          reason,
        }) + `\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`;
    const result = await this.deliverReply(mr, discussion, body, true, state);
    if (result.resolved) {
      console.log(
        `[MaintainerActor] 已说明 discussion ${discussion.id} ${isAlreadyFixed ? '当前已修复' : '无需修复'}并 resolve`
      );
    }
    return this.withDeliveryResult(true, result);
  }

  /**
   * 对 CI 失败执行最小修复。
   *
   * 把失败 job 的日志尾部作为问题上下文交给 FixToolLoop，在 isolated worktree
   * 中完成变更与本地验证，成功后提交推送至 MR source branch。
   * 修复动作与 CI discussion 的关联、回复由调用方（MaintainerRunner）负责。
   */
  async executeCiFix(
    mr: MergeRequest,
    report: CiFailureReport
  ): Promise<{ codeApplied: boolean; reason: string; appliedFiles: string[] }> {
    const failureDigest = report.failedJobs
      .map(
        job =>
          `### job: ${job.name} (stage: ${job.stage}${job.failureReason ? `, reason: ${job.failureReason}` : ''})\n${job.traceTail}`
      )
      .join('\n\n');

    // 从日志中猜测最可能出问题的仓库文件，供修复循环聚焦；失败则退化为通用描述
    let targetFile = '(见 CI 日志)';
    for (const job of report.failedJobs) {
      for (const candidate of extractFileCandidatesFromTrace(job.traceTail)) {
        try {
          const resolved = await this.options.worktreeManager.resolveFilePath(candidate);
          if (resolved) {
            targetFile = candidate;
            break;
          }
        } catch {
          // 路径解析失败时继续尝试下一个候选
        }
      }
      if (targetFile !== '(见 CI 日志)') break;
    }

    const syntheticFinding: ReviewFinding = {
      severity: 'HIGH',
      file: targetFile,
      line: 1,
      ruleId: 'ci-failure',
      message: `CI pipeline 失败，失败 job: ${report.failedJobs.map(job => job.name).join(', ')}`,
      suggestion: '根据 CI 日志定位失败根因，做最小化修复使 pipeline 恢复通过',
      autoFixable: true,
    };

    const extraSystemPrompt = [
      '这是 CI pipeline 失败的自动修复任务。以下是失败 job 的日志尾部：',
      '',
      failureDigest,
      '',
      '要求：',
      '1. 只做让 CI 恢复通过所必需的最小修改，不要顺手重构或修复无关问题。',
      '2. 先在 worktree 中定位并复现失败原因（如运行对应脚本），修复后再次本地验证。',
      '3. 如果日志显示失败与代码无关（如 runner 故障、网络问题），不要修改任何文件，直接结束。',
    ].join('\n');

    console.log(
      `[MaintainerActor] 执行 CI 修复: pipeline=${report.pipelineId ?? 'unknown'}, failedJobs=[${report.failedJobs.map(job => job.name).join(',')}]`
    );

    try {
      console.log(`[MaintainerActor] 阶段=worktree 准备/更新 worktree`);
      await this.options.worktreeManager.ensureWorktree();
      console.log(`[MaintainerActor] 阶段=checkout 切换到 source branch: ${mr.sourceBranch}`);
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);
      console.log(`[MaintainerActor] 阶段=prepare 准备运行环境`);
      await this.options.worktreeManager.prepareEnvironment();

      const loop = new FixToolLoop({
        llmClient: this.options.llmClient,
        worktreeManager: this.options.worktreeManager,
        finding: syntheticFinding,
        mr,
        memoryClient: this.options.memoryClient,
        recallPlanner: this.options.recallPlanner,
        extraSystemPrompt,
      });

      const fixResult = await loop.run();
      this.trackFinalActingRound(loop);
      console.log(`[MaintainerActor] CI 修复结果: success=${fixResult.success}, reason=${fixResult.reason}`);

      if (!fixResult.success) {
        return { codeApplied: false, reason: fixResult.reason, appliedFiles: [] };
      }

      const appliedFiles = [...loop.getAppliedFiles(), ...loop.getDeletedFiles()];
      if (appliedFiles.length === 0) {
        return { codeApplied: false, reason: 'CI 修复未产生任何文件变更', appliedFiles: [] };
      }

      console.log(`[MaintainerActor] 阶段=commit-push 提交 CI 修复到分支: ${mr.sourceBranch}`);
      await this.commitWithConventionRetry(
        mr.sourceBranch,
        `CI pipeline 失败修复。\n失败 job: ${report.failedJobs.map(job => `${job.stage}/${job.name}`).join(', ')}\n修改文件:\n${appliedFiles.map(f => `- ${f}`).join('\n')}`,
        () =>
          [
            `fix(ci): 修复 CI 失败（${report.failedJobs.map(job => job.name).join(', ')}）`,
            '',
            '修改文件：',
            ...appliedFiles.map(f => `- ${f}`),
          ].join('\n'),
        distilledFailure => this.reflowAfterHookFailure(mr, syntheticFinding, distilledFailure)
      );

      return { codeApplied: true, reason: 'CI 修复已推送至 source branch', appliedFiles };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] CI 修复异常: ${reason}`);
      return { codeApplied: false, reason, appliedFiles: [] };
    }
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

  private async deliverReply(
    mr: MergeRequest,
    discussion: Discussion,
    body: string,
    resolve: boolean,
    state: MrAgentState,
    awaitingReply?: { question: string; filePath: string }
  ): Promise<DiscussionDeliveryResult> {
    const threadState = this.getMaintainerThreadState(state, discussion.id);
    return deliverDiscussionReply({
      provider: this.options.provider,
      mr,
      discussion,
      body,
      resolve,
      awaitingReply,
      delivery: threadState.delivery,
      setDelivery: delivery => {
        threadState.delivery = delivery;
      },
      checkpoint: () => this.options.checkpoint?.(),
    });
  }

  private withDeliveryResult(
    codeApplied: boolean,
    delivery: DiscussionDeliveryResult,
    awaitingReply = false
  ): MaintainerActionResult {
    return {
      codeApplied,
      replyPosted: delivery.replyPosted,
      resolved: delivery.resolved,
      awaitingReply,
      pending: delivery.pending,
      error: delivery.error,
    };
  }

  private emptyActionResult(codeApplied: boolean, error?: string): MaintainerActionResult {
    return {
      codeApplied,
      replyPosted: false,
      resolved: false,
      awaitingReply: false,
      pending: false,
      error,
    };
  }

  private mergeActionResults(
    codeResult: MaintainerActionResult,
    replyResult: MaintainerActionResult,
    resolved: boolean
  ): MaintainerActionResult {
    return {
      codeApplied: codeResult.codeApplied,
      replyPosted: replyResult.replyPosted,
      resolved: resolved && replyResult.resolved,
      awaitingReply: replyResult.awaitingReply,
      pending: codeResult.pending || replyResult.pending,
      error: replyResult.error ?? codeResult.error,
    };
  }

  private setAwaitingReply(
    state: MrAgentState,
    discussionId: string,
    question: string,
    fileLine: string,
    askedAt = Date.now()
  ): void {
    const filePath = fileLine.split(':')[0];
    state.interactiveThreads ??= {};
    state.interactiveThreads[discussionId] = {
      status: 'awaiting-reply',
      askedAt,
      question,
      filePath,
    };
  }

  /**
   * 提交并推送（提交管道）。
   *
   * 失败时先由框架机械预处理：归类（commit-message/lint/test/typecheck/permission/push）+
   * 蒸馏（≤10 行诊断）。commit-message 类按项目规则重写 message 重试一次；
   * lint/test/typecheck 类通过 reflow 回流修复循环、修复后重试一次；
   * 其余情况只把蒸馏诊断抛给上层——发布到 MR 的永远不是 hook 原文。
   */
  private async commitWithConventionRetry(
    branch: string,
    changeDescription: string,
    buildDefaultMessage: () => string,
    reflow?: (distilledFailure: string) => Promise<boolean>
  ): Promise<void> {
    const wm = this.options.worktreeManager;
    const message = await this.buildCommitMessage(changeDescription, buildDefaultMessage);
    try {
      await wm.commitAndPush(branch, message, { setUpstream: false });
      this.incrMetric('commitFirstTryPasses');
      return;
    } catch (err) {
      this.incrMetric('commitFirstTryRejections');
      const rawText = err instanceof Error ? err.message : String(err);
      const kind = classifyCommitFailure(rawText);
      const distilled = distillCommitFailure(rawText);
      console.warn(`[MaintainerActor] commit 失败（分类=${kind}），蒸馏诊断:\n${distilled}`);

      if (kind === 'commit-message') {
        const diagnostic = extractCommitRejectionSection(stripAnsiCodes(rawText));
        const recovery = await this.recoverCommitMessage(
          diagnostic,
          message,
          changeDescription,
          branch
        );
        if (recovery) {
          await wm.commitAndPush(branch, recovery.message, { setUpstream: false });
          this.commitConvention = recovery.convention;
          this.commitConventionLoaded = true;
          await this.rememberCommitConvention(recovery.convention);
          return;
        }
      }

      // L3：lint/test/typecheck 类拒绝回流修复循环一次，有新变更则重试提交
      if ((kind === 'lint' || kind === 'test' || kind === 'typecheck') && reflow) {
        console.log(`[MaintainerActor] ${kind} 类 hook 失败回流修复循环`);
        const changed = await reflow(distilled);
        if (changed) {
          await wm.commitAndPush(branch, message, { setUpstream: false });
          return;
        }
        console.warn(`[MaintainerActor] 回流未产生新文件变更，不再重试提交`);
      }

      throw new Error(distilled);
    }
  }

  /**
   * M7：修复循环终局写入 EverOS（成功/失败都记录，失败原因含模式线索）。
   * 与 brain.decide 的决策级记录互补：这里记录的是修复循环的真实结果。
   */
  private async recordFixOutcome(
    mrIid: number,
    finding: ReviewFinding,
    success: boolean,
    reason: string
  ): Promise<void> {
    const memory = this.options.memoryClient;
    if (!memory) {
      return;
    }
    try {
      await memory.recordFixAttempt({
        mrIid,
        file: finding.file,
        line: finding.line,
        success,
        reason: `outcome:${success ? 'success' : 'failure'} | ${reason}`.slice(0, 1500),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[MaintainerActor] 修复终局记忆写入失败: ${message}`);
    }
  }

  /**
   * L3：hook lint/test 类拒绝后的修复回流。
   * 用蒸馏诊断构造合成 finding，驱动一轮标准 FixToolLoop 消除校验错误；
   * 返回是否产生了新的文件变更（有变更才值得重试提交）。
   */
  private async reflowAfterHookFailure(
    mr: MergeRequest,
    baseFinding: ReviewFinding,
    distilledFailure: string,
    extraSystemPrompt?: string
  ): Promise<boolean> {
    this.incrMetric('hookFailureReflows');
    const reflowFinding: ReviewFinding = {
      ...baseFinding,
      line: 1,
      message: `pre-commit hook 校验未通过：${distilledFailure}`,
      suggestion: '根据蒸馏诊断修复 lint/test/typecheck 错误，使本地校验通过',
      autoFixable: true,
    };
    const loop = new FixToolLoop({
      llmClient: this.options.llmClient,
      worktreeManager: this.options.worktreeManager,
      finding: reflowFinding,
      mr,
      memoryClient: this.options.memoryClient,
      recallPlanner: this.options.recallPlanner,
      extraSystemPrompt: [
        '此前修复已完成，但提交被 pre-commit hook 拒绝。以下是框架蒸馏后的失败诊断，请据此消除校验错误后 finish：',
        distilledFailure,
        extraSystemPrompt ?? '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      recheckAlreadyFixed: () => this.options.brain.recheckAlreadyFixed(reflowFinding),
    });
    const result = await loop.run();
    this.trackFinalActingRound(loop);
    console.log(
      `[MaintainerActor] hook 失败回流结果: success=${result.success}, reason=${result.reason}`
    );
    return loop.getAppliedFiles().length > 0 || loop.getDeletedFiles().length > 0;
  }

  /** 按已记忆的项目规范生成提交信息；无规范时使用朴素默认 */
  private async buildCommitMessage(
    changeDescription: string,
    buildDefaultMessage: () => string
  ): Promise<string> {
    const convention = await this.getCommitConvention();
    if (!convention) {
      return buildDefaultMessage();
    }
    try {
      const json = await this.options.llmClient.completeJson(
        [
          '该项目要求 git commit message 遵循以下规范：',
          convention,
          '',
          '请为以下代码修改生成一条符合该规范的完整 commit message（可包含 body）。',
          '要求：',
          '1. 只遵守上方项目规范，不要自行假设 Conventional Commits、固定 type、固定前缀或固定语言。',
          '2. 若规范给出了格式、可选值、正则、长度或示例，必须严格遵守。',
          '3. message 字段只包含最终提交信息，不要添加解释文字、签名或额外标记。',
          '',
          changeDescription,
          '',
          '输出 JSON: { "message": "..." }',
        ].join('\n'),
        undefined,
        {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        }
      );
      const parsed = JSON.parse(json) as { message?: string };
      const message = normalizeGeneratedCommitMessage(parsed.message);
      if (!message) {
        return buildDefaultMessage();
      }
      return message;
    } catch (err) {
      console.warn(
        `[MaintainerActor] 按规范生成提交信息失败，回退默认: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return buildDefaultMessage();
  }

  /**
   * 提交规范三级兜底：EverOS 记忆 → 仓库静态探测（commitlint/husky）→ 调用方的合规默认。
   * 实例级缓存，避免每次提交都召回记忆/扫描磁盘。
   */
  private async getCommitConvention(): Promise<string | undefined> {
    if (this.commitConventionLoaded) {
      return this.commitConvention;
    }
    this.commitConventionLoaded = true;
    const memory = this.options.memoryClient;
    if (memory) {
      try {
        const recalled = await memory.recallProjectKnowledge(
          'commit message 提交信息规范 convention git 提交格式'
        );
        this.commitConvention = recalled.find(
          item => typeof item === 'string' && /commit|提交/i.test(item)
        );
      } catch (err) {
        console.warn(
          `[MaintainerActor] 召回提交规范记忆失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (!this.commitConvention) {
      // 第二级：静态探测仓库 hook/lint 配置，命中即视为 Conventional Commits 项目
      try {
        this.commitConvention = detectCommitConvention(this.options.worktreeManager.getWorktreePath());
        if (this.commitConvention) {
          console.log(`[MaintainerActor] 静态探测到项目提交规范: ${this.commitConvention}`);
        }
      } catch (err) {
        console.warn(
          `[MaintainerActor] 静态探测提交规范失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return this.commitConvention;
  }

  /** 根据 commit 失败尾部诊断生成替代提交信息，并将识别出的规则写入项目级记忆 */
  private async recoverCommitMessage(
    diagnostic: string,
    attemptedMessage: string,
    changeDescription: string,
    branch: string
  ): Promise<{ convention: string; message: string } | undefined> {
    try {
      const json = await this.options.llmClient.completeJson(
        [
          '以下是 git commit 失败输出的尾部诊断。',
          '请判断最终失败是否由提交信息本身不符合当前项目规则引起。',
          '项目规则可能是任意自定义格式、前缀、可选值、正则、长度、语言或模板；',
          '不要假设项目使用 Conventional Commits，也不要使用诊断中没有给出的固定 type 列表。',
          '如果尾部明确指出提交信息、标题、说明、message、header、subject、首行、格式或正则约束不合规，retry 才为 true。',
          '如果真正失败原因是 lint、测试、构建、权限或 push，retry 必须为 false。',
          'retry 为 true 时：',
          '1. convention 用一到两句话准确概括诊断中出现的项目规则；',
          '2. message 根据该规则和本次修改生成新的完整提交信息；',
          '3. message 只包含提交信息，不附加解释，也不要复用已被拒绝的原始信息。',
          '',
          '输出 JSON: { "retry": true/false, "convention": "...", "message": "..." }',
          '',
          '--- 已被拒绝的提交信息 ---',
          attemptedMessage,
          '',
          '--- 本次修改 ---',
          changeDescription,
          '',
          '--- 当前分支 ---',
          branch,
          '',
          '--- 尾部诊断 ---',
          diagnostic,
        ].join('\n'),
        undefined,
        {
          type: 'object',
          properties: {
            retry: { type: 'boolean' },
            convention: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['retry', 'convention', 'message'],
        }
      );
      const parsed = JSON.parse(json) as {
        retry?: boolean;
        convention?: string;
        message?: string;
      };
      const convention = parsed.convention?.trim();
      const message = normalizeGeneratedCommitMessage(parsed.message);
      if (!parsed.retry || !convention || !message || message === attemptedMessage.trim()) {
        return undefined;
      }
      return { convention, message };
    } catch (err) {
      console.warn(
        `[MaintainerActor] 根据 hook 尾部诊断恢复提交信息失败: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /** 项目规范记忆失败不应阻断已经生成的合规提交重试 */
  private async rememberCommitConvention(convention: string): Promise<void> {
    const memory = this.options.memoryClient;
    if (!memory) {
      return;
    }
    try {
      await memory.recordProjectKnowledge([
        {
          id: `commit-convention-${memory.context.projectId}`,
          category: 'convention',
          sourceFiles: [],
          content: `提交信息（commit message）规范：${convention}`,
          confidence: 'high',
          createdAt: new Date().toISOString(),
        },
      ]);
      console.log(`[MaintainerActor] 已学习并记忆该项目提交规范: ${convention}`);
    } catch (err) {
      console.warn(
        `[MaintainerActor] 记录项目提交规范失败，继续提交重试: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** 清理模型生成的提交信息，保留项目自定义格式但移除不可见空字符 */
function normalizeGeneratedCommitMessage(message: string | undefined): string | undefined {
  const normalized = message?.replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  return normalized || undefined;
}

/**
 * 清理提交信息主题：压缩为单行并截断，避免异常长的 subject。
 */
function sanitizeCommitSubject(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  const truncated = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
  return truncated || '修复 Reviewer 提出的问题';
}

/**
 * 合规默认提交信息：Conventional Commits 形态（第三级兜底）。
 * 若项目实际规范不同，hook 拒绝后会触发规范学习并按项目规则重写。
 */
function buildDefaultFixMessage(finding: ReviewFinding): string {
  return pipelineBuildDefaultFixMessage({
    message: sanitizeCommitSubject(finding.message),
    ruleId: finding.ruleId,
    file: finding.file,
    line: finding.line,
  });
}

/** 合规默认批量提交信息 */
function buildDefaultBatchMessage(appliedFiles: string[], deletedFiles: string[]): string {
  return pipelineBuildDefaultBatchMessage(appliedFiles, deletedFiles);
}
