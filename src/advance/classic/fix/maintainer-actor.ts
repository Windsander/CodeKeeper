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
import { basename } from 'node:path';
import { defaultPromptLoader } from '../../llm/prompts/loader.js';

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
  /** 项目提交信息规范缓存（实例级，避免每次提交都召回记忆） */
  private commitConvention?: string;
  private commitConventionLoaded = false;

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
        if (decision.deleteFile) {
          const success = await this.executeDeleteFileFix(mr, discussion, finding, decision);
          if (!success) {
            const question = defaultPromptLoader.load('maintainer-delete-failed-ask', {
              file: finding.file,
            });
            await this.ask(mr, discussion, question, finding.file, state);
          }
          return success;
        }
        const success = await this.executeFix(mr, discussion, finding, decision);
        if (!success) {
          const question = defaultPromptLoader.load('maintainer-fix-failed-ask', {
            fileLine: `${finding.file}:${finding.line}`,
          });
          await this.ask(mr, discussion, question, finding.file, state);
        }
        return success;
      }
      case 'ask': {
        const question = decision.question ?? defaultPromptLoader.load('maintainer-ask-clarify');
        await this.ask(mr, discussion, question, finding.file, state);
        return true;
      }
      case 'ignore': {
        await this.ignore(mr, discussion, decision.reason ?? '无需处理', decision);
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
    alreadyFixedItems: Array<{ fileLine: string; reason: string }>,
    state: MrAgentState
  ): Promise<void> {
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
      return;
    }

    const body = `${sections.join('\n\n')}\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`;
    console.log(
      `[MaintainerActor] discussion ${discussion.id} 汇总回复 counts=fixed:${fixedItems.length},alreadyFixed:${alreadyFixedItems.length},failed:${failedItems.length},asked:${askedItems.length},ignored:${ignoredItems.length}`
    );

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
        await this.commitWithConventionRetry(mr.sourceBranch, changeDescription, () =>
          buildDefaultBatchMessage(Array.from(appliedFiles), Array.from(deletedFiles))
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
    decision: MaintainerDecision
  ): Promise<boolean> {
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
      console.log(
        `[MaintainerActor] 修复结果: success=${fixResult.success}, reason=${fixResult.reason}`
      );

      if (fixResult.alreadyFixed) {
        decision.action = 'ignore';
        decision.alreadyFixed = true;
        decision.reason = fixResult.reason;
        decision.replyBody = fixResult.evidence || fixResult.reason;
        await this.ignore(mr, discussion, decision.reason, decision);
        return true;
      }

      if (!fixResult.success) {
        return false;
      }

      console.log(`[MaintainerActor] 阶段=commit-push 提交并推送修复到分支: ${mr.sourceBranch}`);
      await this.commitWithConventionRetry(
        mr.sourceBranch,
        `问题: ${finding.message}\n规则: ${finding.ruleId ?? 'N/A'}\n文件: ${finding.file}:${finding.line}`,
        () => buildDefaultFixMessage(finding)
      );

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

  /**
   * 执行文件删除修复：Reviewer 指出某文件不应出现在 MR 中时，
   * 在 worktree 中删除该文件并提交推送。
   */
  private async executeDeleteFileFix(
    mr: MergeRequest,
    discussion: Discussion,
    finding: ReviewFinding,
    decision: MaintainerDecision
  ): Promise<boolean> {
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
        return false;
      }

      console.log(`[MaintainerActor] 阶段=delete 删除文件: ${resolvedPath}`);
      await this.options.worktreeManager.removeFile(resolvedPath);

      const changeDescription = `Reviewer 指出文件 ${finding.file} 不应上传，已从 MR 中删除。`;
      console.log(`[MaintainerActor] 阶段=commit-push 提交删除到分支: ${mr.sourceBranch}`);
      await this.commitWithConventionRetry(
        mr.sourceBranch,
        changeDescription,
        () => `chore: 移除不应上传的文件 ${basename(finding.file)}`
      );

      try {
        await this.options.provider.resolveDiscussion(mr.iid, discussion.id);

        const cognitive = decision as CognitiveDecision;
        const reasoningSection = cognitive.reasoning
          ? `\n\n**问题分析**\n${cognitive.analysis ?? '未提供'}\n\n**考虑过的方案**\n${cognitive.consideredOptions?.map((o: string) => `- ${o}`).join('\n') ?? '无'}\n\n**最终决策**\n${cognitive.reasoning}`
          : '';

        await this.options.provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          `✅ ${this.options.maintainerName} 已根据 Reviewer 的意见删除文件 \`${finding.file}\` 并推送至本分支。${reasoningSection}\n\n请 Reviewer 复核变更。\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, this.options.maintainerName)}`
        );
        console.log(`[MaintainerActor] 已删除文件并 resolve discussion ${discussion.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MaintainerActor] resolve discussion ${discussion.id} 失败: ${message}`);
      }

      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MaintainerActor] 删除文件修复异常: ${reason}`);
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

  private async ignore(
    mr: MergeRequest,
    discussion: Discussion,
    reason: string,
    decision: MaintainerDecision
  ): Promise<void> {
    const { maintainerName, provider } = this.options;
    try {
      const isAlreadyFixed = decision.alreadyFixed === true;
      let body: string;
      if (isAlreadyFixed) {
        body =
          defaultPromptLoader.load('maintainer-already-fixed-reply', {
            maintainerName,
            replyBody: decision.replyBody || reason,
          }) + `\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`;
      } else {
        body =
          defaultPromptLoader.load('maintainer-ignore-reply', {
            maintainerName,
            reason,
          }) + `\n\n${formatAgentFooter(MAINTAINER_ROLE_LABEL, maintainerName)}`;
      }
      await provider.addDiscussionNote(mr.iid, discussion.id, body);
      if (isAlreadyFixed) {
        await provider.resolveDiscussion(mr.iid, discussion.id);
        console.log(`[MaintainerActor] 已标记 discussion ${discussion.id} 为已修复并 resolve`);
      } else {
        console.log(`[MaintainerActor] 已忽略 discussion ${discussion.id}`);
      }
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

  /**
   * 提交并推送；若被项目 hook 以提交信息规范为由拒绝，
   * 让 LLM 从 hook 输出中提取规范、写入项目记忆，并按规范重新生成 message 重试一次。
   */
  private async commitWithConventionRetry(
    branch: string,
    changeDescription: string,
    buildDefaultMessage: () => string
  ): Promise<void> {
    const wm = this.options.worktreeManager;
    const message = await this.buildCommitMessage(changeDescription, buildDefaultMessage);
    try {
      await wm.commitAndPush(branch, message, { setUpstream: false });
      return;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.warn(
        `[MaintainerActor] commit 被拒绝，尝试从 hook 输出学习提交规范: ${errorText.slice(0, 500)}`
      );
      const convention = await this.learnCommitConvention(errorText);
      if (!convention) {
        // 拒绝原因与提交信息格式无关（如 lint/测试失败），不重试
        throw err;
      }
      const retryMessage = await this.buildCommitMessage(changeDescription, buildDefaultMessage);
      await wm.commitAndPush(branch, retryMessage, { setUpstream: false });
    }
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
          '1. message 字段必须直接以 <type> 或 <type>(<scope>): 开头，例如 fix: 描述、fix(core): 描述。',
          '2. 不要添加解释文字、签名或 [CodeKeeper] 等额外标记。',
          '3. 优先从修改内容本身推断 type；如果确实只是测试，可用 test:；如果只是 chore，可用 chore:。',
          '',
          '可使用的 type（优先从规范中选择）：feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert。',
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
      let message = parsed.message?.trim();
      if (!message) {
        return buildDefaultMessage();
      }
      // 兜底校验：若 LLM 仍未生成 type 前缀，按 fix: 处理
      if (
        !/^(revert:\s*)?(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\([^)]+\))?:\s*.+/i.test(
          message
        )
      ) {
        message = `fix: ${message}`;
      }
      return message;
    } catch (err) {
      console.warn(
        `[MaintainerActor] 按规范生成提交信息失败，回退默认: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return buildDefaultMessage();
  }

  /** 从项目记忆召回提交信息规范（实例级缓存） */
  private async getCommitConvention(): Promise<string | undefined> {
    if (this.commitConventionLoaded) {
      return this.commitConvention;
    }
    this.commitConventionLoaded = true;
    const memory = this.options.memoryClient;
    if (!memory) {
      return undefined;
    }
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
    return this.commitConvention;
  }

  /** 从 commit 失败的 hook 输出中提取项目提交规范，并写入项目级记忆 */
  private async learnCommitConvention(errorOutput: string): Promise<string | undefined> {
    try {
      const clean = stripAnsiCodes(errorOutput);
      const section = extractCommitRejectionSection(clean);

      const json = await this.options.llmClient.completeJson(
        [
          '以下是 git commit 被项目 hook 拒绝时的输出（已过滤，仅保留与提交信息规范最相关的部分）。',
          '请判断拒绝原因是否与 commit message 格式规范有关。',
          '如果是，提取该项目要求的提交信息规范（格式说明、类型列表、示例等），用一到两句话概括；',
          '如果不是格式问题（例如 lint 或测试未通过），convention 输出空字符串。',
          '',
          '输出 JSON: { "convention": "..." }',
          '',
          '--- hook 输出 ---',
          section.slice(0, 4000),
        ].join('\n'),
        undefined,
        {
          type: 'object',
          properties: { convention: { type: 'string' } },
          required: ['convention'],
        }
      );
      const parsed = JSON.parse(json) as { convention?: string };
      const convention = parsed.convention?.trim();
      if (!convention) {
        return undefined;
      }
      this.commitConvention = convention;
      this.commitConventionLoaded = true;
      const memory = this.options.memoryClient;
      if (memory) {
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
      }
      return convention;
    } catch (err) {
      console.warn(
        `[MaintainerActor] 提取提交规范失败: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }
}

/** 去除 ANSI 转义码，避免 hook 输出中的颜色控制字符干扰规范提取 */
export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** 从冗长的 hook 输出中定位与 commit message 规范相关的片段 */
export function extractCommitRejectionSection(text: string): string {
  const markers = [
    'commit message',
    'commit-message',
    'commit-msg',
    '提交信息',
    'Conventional Commits',
    'Conventional Commit',
    '不符合',
    '格式:',
    '格式：',
  ];
  const lower = text.toLowerCase();
  let idx = -1;
  for (const marker of markers) {
    const i = lower.indexOf(marker.toLowerCase());
    if (i !== -1 && (idx === -1 || i < idx)) {
      idx = i;
    }
  }
  if (idx === -1) {
    return text.slice(0, 4000);
  }
  return text.slice(idx, idx + 4000);
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
 * 朴素默认提交信息：不预设任何项目格式。
 * 若目标项目 hook 拒绝，会触发提交规范学习并重试。
 */
function buildDefaultFixMessage(finding: ReviewFinding): string {
  return [
    sanitizeCommitSubject(finding.message),
    '',
    `规则: ${finding.ruleId ?? 'N/A'}`,
    `文件: ${finding.file}:${finding.line}`,
  ].join('\n');
}

/** 朴素默认批量提交信息 */
function buildDefaultBatchMessage(appliedFiles: string[], deletedFiles: string[]): string {
  const total = appliedFiles.length + deletedFiles.length;
  const lines = [`批量修复 ${total} 个 Reviewer 问题`, ''];
  if (appliedFiles.length > 0) {
    lines.push('修改文件：', ...appliedFiles.map(f => `- ${f}`), '');
  }
  if (deletedFiles.length > 0) {
    lines.push('删除文件：', ...deletedFiles.map(f => `- ${f}`), '');
  }
  return lines.join('\n');
}
