import type { GitLabProvider } from '../provider/gitlab-provider.js';
import type { MergeRequest, ReviewFinding, Discussion } from '../provider/types.js';
import type { MrFixAgent } from './mr-fix-agent.js';
import type { MaintainerDecision } from './maintainer-brain.js';
import type { MrAgentState } from '../runners/shared/state-utils.js';
import { formatAgentFooter, MAINTAINER_ROLE_LABEL } from '../runners/shared/review-utils.js';

export interface MaintainerActorOptions {
  /** GitLab API 提供者 */
  provider: GitLabProvider;
  /** 修复执行器 */
  fixAgent: MrFixAgent;
  /** Maintainer Agent 显示名称，用于评论签名 */
  maintainerName: string;
}

/**
 * MaintainerActor
 *
 * 负责把 MaintainerBrain 的决策转化为实际行动：
 * - fix：调用 MrFixAgent 执行修复、resolve discussion、追加说明
 * - ask：在 discussion 下发表评论提问，记录交互状态
 * - ignore：回复说明忽略原因
 *
 * 本类只关注“决策 → GitLab / worktree 动作”，不管理调度或状态生命周期。
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
  ): Promise<void> {
    switch (decision.action) {
      case 'fix': {
        const fixDescription = decision.fixDescription ?? '根据 Reviewer 意见修改代码';
        const success = await this.executeFix(mr, discussion, finding, fixDescription);
        if (!success) {
          const question = `我尝试自动修复 ${finding.file}:${finding.line}，但未成功。请 Reviewer 补充期望的修改方式或范围。`;
          await this.ask(mr, discussion, question, finding.file, state);
        }
        break;
      }
      case 'ask': {
        const question = decision.question ?? '能否补充一下期望的修改方式或范围？';
        await this.ask(mr, discussion, question, finding.file, state);
        break;
      }
      case 'ignore': {
        await this.ignore(mr, discussion, decision.reason ?? '无需处理');
        break;
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
   * 执行修复并在 GitLab 上反馈结果
   */
  async executeFix(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    fixDescription: string
  ): Promise<boolean> {
    const syntheticFinding: ReviewFinding = {
      ...finding,
      message: fixDescription,
      suggestion: fixDescription,
      autoFixable: true,
    };

    console.log(`[MaintainerActor] 执行修复: ${finding.file}:${finding.line}`);
    const fixResult = await this.options.fixAgent.executeFix(syntheticFinding, mr);
    console.log(`[MaintainerActor] 修复结果: success=${fixResult.success}, reason=${fixResult.reason}`);

    const { maintainerName, provider } = this.options;

    if (fixResult.success) {
      try {
        await provider.resolveDiscussion(mr.iid, discussion.id);
        await provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          `✅ ${maintainerName} 已根据 Reviewer 的意见自动修复并推送至本分支。\n\n请 Reviewer 复核变更。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`
        );
        console.log(`[MaintainerActor] 已修复并 resolve discussion ${discussion.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerActor] resolve discussion ${discussion.id} 失败: ${message}`);
      }
      return true;
    }

    try {
      await provider.addDiscussionNote(
        mr.iid,
        discussion.id,
        `⏸️ ${maintainerName} 尝试按 Reviewer 描述修复但未成功：${fixResult.reason}\n\n请 Reviewer 确认是否需要人工处理。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`
      );
      console.log(`[MaintainerActor] 已追加修复失败说明`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MaintainerActor] 回复 discussion ${discussion.id} 失败: ${message}`);
    }
    return false;
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
