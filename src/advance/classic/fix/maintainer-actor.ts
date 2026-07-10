import type { GitLabProvider } from '../provider/gitlab-provider.js';
import type { MergeRequest, ReviewFinding, Discussion } from '../provider/types.js';
import type { LlmClient } from '../../llm/client.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { MaintainerBrain, MaintainerDecision } from './maintainer-brain.js';
import type { CognitiveDecision } from './cognitive-types.js';
import type { MrAgentState } from '../runners/shared/state-utils.js';
import type { IMemoryClient } from '../memory/types.js';
import type { RecallPlanner } from '../memory/recall-planner.js';
import { FixToolLoop } from './fix-tool-loop.js';
import { formatAgentFooter, MAINTAINER_ROLE_LABEL } from '../runners/shared/review-utils.js';

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
  constructor(private readonly options: MaintainerActorOptions) {}

  /**
   * 对单条 finding/discussion 应用决策
   */
  async applyDecision(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    decision: MaintainerDecision,
    state: MrAgentState
  ): Promise<boolean> {
    switch (decision.action) {
      case 'fix': {
        const success = await this.executeFix(mr, discussion, finding, decision);
        if (!success) {
          const question = `我尝试自动修复 ${finding.file}:${finding.line}，但未成功。请 Reviewer 补充期望的修改方式或范围，我会再试一次。`;
          await this.ask(mr, discussion, question, finding.file, state);
        }
        return success;
      }
      case 'ask': {
        const question = decision.question ?? '能否补充一下期望的修改方式或范围？';
        await this.ask(mr, discussion, question, finding.file, state);
        return true;
      }
      case 'ignore': {
        await this.ignore(mr, discussion, decision.reason ?? '无需处理');
        return true;
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
    state: MrAgentState
  ): Promise<void> {
    const sections: string[] = [];

    if (fixedItems.length > 0) {
      sections.push(
        `✅ 已自动修复并推送：\n${fixedItems.map((item) => `- ${item}`).join('\n')}`
      );
    }
    if (failedItems.length > 0) {
      sections.push(
        `⏸️ 尝试修复未成功：\n${failedItems.map((item) => `- ${item}`).join('\n')}`
      );
    }
    if (askedItems.length > 0) {
      sections.push(
        `❓ 需要 Reviewer 澄清：\n${askedItems.map((item) => `- ${item.fileLine}: ${item.text}`).join('\n')}`
      );
    }
    if (ignoredItems.length > 0) {
      sections.push(
        `📝 已忽略：\n${ignoredItems.map((item) => `- ${item.fileLine}: ${item.reason}`).join('\n')}`
      );
    }

    if (sections.length === 0) {
      console.log(`[MaintainerActor] discussion ${discussion.id} 没有任何处理结果，跳过回复`);
      return;
    }

    const body = `${sections.join('\n\n')}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`;

    try {
      await this.options.provider.addDiscussionNote(mr.iid, discussion.id, body);

      // 只有在全部处理完成且没有待澄清/失败项时才 resolve
      if (fixedItems.length > 0 && failedItems.length === 0 && askedItems.length === 0) {
        await this.options.provider.resolveDiscussion(mr.iid, discussion.id);
        console.log(`[MaintainerActor] 汇总 discussion ${discussion.id} 已全部修复并 resolve`);
      } else if (askedItems.length > 0) {
        this.setAwaitingReply(state, discussion.id, askedItems[0].text, askedItems[0].fileLine);
        console.log(`[MaintainerActor] 汇总 discussion ${discussion.id} 有待澄清项，等待回复`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerActor] 回复 discussion ${discussion.id} 失败: ${message}`);
    }
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
        });

        const result = await loop.run();
        console.log(`[MaintainerActor] finding ${finding.file}:${finding.line} 修复结果: success=${result.success}, reason=${result.reason}`);

        if (!result.success) {
          return {
            success: false,
            reason: result.reason,
            appliedFiles: Array.from(appliedFiles),
            deletedFiles: Array.from(deletedFiles),
          };
        }

        for (const f of loop.getAppliedFiles()) {
          appliedFiles.add(f);
        }
        for (const f of loop.getDeletedFiles()) {
          deletedFiles.add(f);
        }
      }

      if (appliedFiles.size === 0 && deletedFiles.size === 0) {
        return {
          success: false,
          reason: '没有文件被修改或删除',
          appliedFiles: [],
          deletedFiles: [],
        };
      }

      const message = `[CodeKeeper] fix: 批量修复\n\n${
        appliedFiles.size > 0 ? `修改文件：\n${Array.from(appliedFiles).map((f) => `- ${f}`).join('\n')}\n\n` : ''
      }${deletedFiles.size > 0 ? `删除文件：\n${Array.from(deletedFiles).map((f) => `- ${f}`).join('\n')}\n\n` : ''}`;
      console.log(`[MaintainerActor] 阶段=commit-push 批量提交到分支: ${mr.sourceBranch}`);
      await this.options.worktreeManager.commitAndPush(mr.sourceBranch, message, { setUpstream: false });

      return {
        success: true,
        reason: '批量修复已推送至 source branch',
        appliedFiles: Array.from(appliedFiles),
        deletedFiles: Array.from(deletedFiles),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] 批量修复异常: ${reason}`);
      return { success: false, reason, appliedFiles: [], deletedFiles: [] };
    }
  }

  async executeFix(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    decision: MaintainerDecision
  ): Promise<boolean> {
    const fixDescription = decision.fixDescription ?? '根据 Reviewer 意见修改代码';
    const syntheticFinding: ReviewFinding = {
      ...finding,
      message: fixDescription || finding.message,
      suggestion: fixDescription || finding.suggestion,
      autoFixable: true,
    };

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
      });

      const fixResult = await loop.run();
      console.log(`[MaintainerActor] 修复结果: success=${fixResult.success}, reason=${fixResult.reason}`);

      if (!fixResult.success) {
        return false;
      }

      const message = `[CodeKeeper] fix: ${finding.message}\n\n规则: ${finding.ruleId ?? 'N/A'}\n文件: ${finding.file}:${finding.line}`;
      console.log(`[MaintainerActor] 阶段=commit-push 提交并推送修复到分支: ${mr.sourceBranch}`);
      await this.options.worktreeManager.commitAndPush(mr.sourceBranch, message, {
        setUpstream: false,
      });

      try {
        await this.options.provider.resolveDiscussion(mr.iid, discussion.id);

        const cognitive = decision as CognitiveDecision;
        const reasoningSection = cognitive.reasoning
          ? `\n\n**问题分析**\n${cognitive.analysis ?? '未提供'}\n\n**考虑过的方案**\n${cognitive.consideredOptions?.map((o: string) => `- ${o}`).join('\n') ?? '无'}\n\n**最终决策**\n${cognitive.reasoning}`
          : '';

        await this.options.provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          `✅ ${this.options.maintainerName} 已根据 Reviewer 的意见自动修复并推送至本分支。${reasoningSection}\n\n请 Reviewer 复核变更。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`
        );
        console.log(`[MaintainerActor] 已修复并 resolve discussion ${discussion.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerActor] resolve discussion ${discussion.id} 失败: ${message}`);
      }

      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] 修复异常: ${reason}`);
      return false;
    }
  }

  private async ask(
    mr: MergeRequest,
    discussion: Discussion,
    question: string,
    filePath: string,
    state: MrAgentState
  ): Promise<void> {
    try {
      await this.options.provider.addDiscussionNote(
        mr.iid,
        discussion.id,
        `${question}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`
      );
      this.setAwaitingReply(state, discussion.id, question, filePath);
      console.log(`[MaintainerActor] 已在 discussion ${discussion.id} 提出澄清问题`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerActor] 提出澄清问题失败: ${message}`);
    }
  }

  private async ignore(mr: MergeRequest, discussion: Discussion, reason: string): Promise<void> {
    const { maintainerName, provider } = this.options;
    try {
      await provider.addDiscussionNote(
        mr.iid,
        discussion.id,
        `📝 ${maintainerName} 决定忽略本 discussion：${reason}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`
      );
      console.log(`[MaintainerActor] 已忽略 discussion ${discussion.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerActor] 回复 discussion ${discussion.id} 失败: ${message}`);
    }
  }

  private setAwaitingReply(
    state: MrAgentState,
    discussionId: string,
    question: string,
    fileLine: string
  ): void {
    const filePath = fileLine.split(':')[0];
    state.interactiveThreads[discussionId] = {
      status: 'awaiting-reply',
      askedAt: Date.now(),
      question,
      filePath,
    };
  }
}
