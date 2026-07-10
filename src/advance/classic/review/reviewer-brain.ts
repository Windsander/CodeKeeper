import { LlmClient } from '../../llm/client.js';
import type { MergeRequest, MrDiff, ReviewFinding, ReviewResult } from '../provider/types.js';
import type { IMemoryClient } from '../memory/types.js';
import type { RecallPlanner } from '../memory/recall-planner.js';
import {
  summarizeThreadNotes,
  formatThreadContext,
  type ThreadContext,
} from '../utils/context-window.js';
import { logger } from '../../../core/logger.js';
import { extractJsonText } from '../utils/json-extraction.js';

export interface ReviewerBrainOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
  /** Token 预算上限 */
  tokenBudget: number;
  /** 评审规则文本 */
  rules: string;
  /** MR Agent 个性/策略配置（SOUL.md 内容） */
  soulContent?: string;
  /** 项目自动归纳的智库内容（context.md 摘要） */
  projectContext?: string;
  /** 可选的记忆客户端，用于记录评审历史 */
  memoryClient?: IMemoryClient;
  /** 可选的记忆查询规划器，让 Agent 按需决定查什么记忆 */
  recallPlanner?: RecallPlanner;
}

/**
 * ReviewerBrain
 *
 * Reviewer 的决策大脑：根据 MR diff、评审规则、项目背景，
 * 由 LLM 输出结构化的 findings 和整体 summary，
 * 并判断是否需要回复别人对评审结论的评论。
 */
export class ReviewerBrain {
  constructor(private readonly options: ReviewerBrainOptions) {}

  /**
   * 对 MR 的 diff 列表执行评审
   */
  async review(mr: MergeRequest, diffs: MrDiff[]): Promise<ReviewResult> {
    if (diffs.length === 0) {
      return { findings: [], summary: 'No changes to review', autoFixable: [] };
    }

    const recalledContext = await this.recallContext(mr, diffs);
    const prompt = this.buildReviewPrompt(mr, diffs, recalledContext);
    const response = await this.options.llmClient.completeJson(
      prompt,
      '你是严格的代码评审助手。请只输出 JSON。'
    );

    const result = this.parseReviewResponse(response);

    return result;
  }

  /**
   * 判断是否需要回复别人对Reviewer评审结论的评论，并生成回复内容。
   *
   * 仅处理质疑、询问、要求澄清等需要认知层回应的场景；
   * 对 LGTM、emoji、纯感谢等无需回复的内容返回 shouldReply=false。
   */
  async replyToComment(input: ReviewerReplyInput): Promise<ReviewerReplyResult> {
    const threadContext = await summarizeThreadNotes(
      this.options.llmClient,
      input.threadNotes,
      { maxRawTokens: 8000, maxRecentItems: 5 }
    );
    const recalledContext = await this.recallContextForReply(input, threadContext);
    const prompt = this.buildReplyPrompt(input, threadContext, recalledContext);
    const response = await this.options.llmClient.completeJson(
      prompt,
      '你是严格的代码评审助手。请只输出 JSON。'
    );
    return this.parseReplyResponse(response);
  }

  private async recallContextForReply(
    input: ReviewerReplyInput,
    threadContext: ThreadContext
  ): Promise<string> {
    if (!this.options.recallPlanner) return '';
    const findingsText = input.originalFindings
      .map(
        (f) =>
          `- [${f.severity}] \`${f.file}:${f.line}\` ${f.message}\n  建议：${f.suggestion}`
      )
      .join('\n');
    const plan = await this.options.recallPlanner.plan({
      role: 'reviewer',
      taskType: 'reply',
      taskSummary: `${formatThreadContext(threadContext)}\n\n待回复评论：${input.targetNote.body}`.slice(0, 3000),
      availableFindings: findingsText,
    });
    if (!plan.needsRecall || plan.queries.length === 0) return '';
    const memories = await this.options.recallPlanner.execute(plan);
    if (memories.length === 0) return '';
    return `\n\n相关历史记忆：\n${memories.map((m) => `- ${m}`).join('\n')}`;
  }

  private async recallContext(mr: MergeRequest, diffs: MrDiff[]): Promise<string> {
    if (!this.options.recallPlanner) return '';
    const diffSummary = diffs.map((d) => `${d.newPath}\n${d.diff}`).join('\n');
    const plan = await this.options.recallPlanner.plan({
      role: 'reviewer',
      taskType: 'review',
      taskSummary: `${mr.title}\n${mr.description ?? ''}\n${diffSummary}`.slice(0, 3000),
    });
    if (!plan.needsRecall || plan.queries.length === 0) return '';
    const memories = await this.options.recallPlanner.execute(plan);
    if (memories.length === 0) return '';
    return `\n\n相关历史记忆：\n${memories.map((m) => `- ${m}`).join('\n')}`;
  }

  private buildReviewPrompt(mr: MergeRequest, diffs: MrDiff[], recalledContext: string): string {
    const diffText = diffs
      .map(
        (d) =>
          `--- ${d.oldPath}\n+++ ${d.newPath}\n${d.newFile ? '(new file)' : ''}${d.deletedFile ? '(deleted)' : ''}\n${d.diff}`
      )
      .join('\n\n');

    const soulSection = this.options.soulContent
      ? `\n\nAgent 个性与策略（SOUL.md）：\n${this.options.soulContent}`
      : '';

    const contextSection = this.options.projectContext
      ? `\n\n项目背景与智库：\n${this.options.projectContext}`
      : '';

    return `请对以下 Merge Request 进行代码评审。

MR 标题: ${mr.title}
MR 描述: ${mr.description}
源分支: ${mr.sourceBranch} -> 目标分支: ${mr.targetBranch}

评审规则:
${this.options.rules}${soulSection}${contextSection}${recalledContext}

变更内容:
\`\`\`diff
${diffText}
\`\`\`

请严格按照以下 JSON 格式输出评审结果，不要包含任何其他文字:

{
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "文件路径",
      "line": 行号,
      "ruleId": "规则编号（可选）",
      "message": "问题描述",
      "suggestion": "修改建议",
      "autoFixable": true|false
    }
  ],
  "summary": "整体评审总结",
  "autoFixable": [0, 1, ...]
}

如果没有发现问题，findings 为空数组，summary 简要说明。`;
  }

  private parseReviewResponse(rawResponse: string): ReviewResult {
    try {
      const cleaned = this.extractJsonFromMarkdown(rawResponse);
      const parsed = JSON.parse(cleaned) as {
        findings?: unknown[];
        summary?: string;
        autoFixable?: number[];
      };

      const findings = this.normalizeFindings(parsed.findings ?? []);
      const autoFixable = this.extractAutoFixableIndices(findings, parsed.autoFixable);

      return {
        findings,
        summary: parsed.summary ?? '评审完成，未生成总结',
        autoFixable,
        rawResponse,
      };
    } catch (err) {
      logger.warn(
        { rawResponse: rawResponse.slice(0, 2000), err: err instanceof Error ? err.message : String(err) },
        'ReviewerBrain 评审响应解析失败'
      );
      throw new Error('评审响应解析失败，请检查 LLM 输出格式');
    }
  }

  private buildReplyPrompt(input: ReviewerReplyInput, threadContext: ThreadContext, recalledContext: string): string {
    const findingsText = input.originalFindings
      .map(
        (f) =>
          `- [${f.severity}] \`${f.file}:${f.line}\` ${f.message}\n  建议：${f.suggestion}`
      )
      .join('\n');

    const notesText = formatThreadContext(threadContext);

    const soulSection = this.options.soulContent
      ? `\n\nReviewer 个性与策略（SOUL.md）：\n${this.options.soulContent}`
      : '';

    const contextSection = this.options.projectContext
      ? `\n\n项目背景与智库：\n${this.options.projectContext}`
      : '';

    return `你是对以下 Merge Request 进行评审的 Reviewer Agent。有用户在你在 GitLab MR 中创建的 discussion / comment 下发表了新意见，请你判断是否需要进行回复。

MR 标题: ${input.mr.title}
MR 描述: ${input.mr.description}
源分支: ${input.mr.sourceBranch} -> 目标分支: ${input.mr.targetBranch}

你最初的评审发现：
${findingsText || '（无结构化 findings）'}

该 discussion 的历史评论：
${notesText}${recalledContext}

需要你判断是否回复的最新评论：
【待回复】${input.targetNote.author} (${input.targetNote.createdAt}):
${input.targetNote.body}

评审规则：
${this.options.rules}${soulSection}${contextSection}

请严格按照以下 JSON 格式输出，不要包含任何其他文字：

{
  "shouldReply": true|false,
  "replyBody": "如果需要回复，给出 concise 的回复正文（Markdown）；如果不需要回复，为空字符串",
  "reason": "简短说明判断理由"
}

判断原则：
- 如果是疑问、质疑、要求澄清、需要你进一步说明，shouldReply=true。
- 如果是 "LGTM"、"thanks"、"👍"、纯表情、明显不需要回应的客套话，shouldReply=false。
- 回复时保持 Reviewer 的专业、客观、简洁，不道歉、不承诺修改代码。
- 如果用户指出你的 finding 确实有误，可以承认并说明会忽略或更新该 finding。`;
  }

  private parseReplyResponse(rawResponse: string): ReviewerReplyResult {
    try {
      const cleaned = this.extractJsonFromMarkdown(rawResponse);
      const parsed = JSON.parse(cleaned) as {
        shouldReply?: boolean;
        replyBody?: string;
        reason?: string;
      };
      return {
        shouldReply: parsed.shouldReply === true,
        replyBody: parsed.replyBody ?? '',
        reason: parsed.reason ?? '未提供理由',
      };
    } catch (err) {
      logger.warn(
        { rawResponse: rawResponse.slice(0, 500), err: err instanceof Error ? err.message : String(err) },
        'ReviewerBrain 回复决策解析失败，保守不回复'
      );
      return { shouldReply: false, replyBody: '', reason: 'LLM 回复解析失败，保守不回复' };
    }
  }

  private extractJsonFromMarkdown(text: string): string {
    return extractJsonText(text);
  }

  private normalizeFindings(rawFindings: unknown[]): ReviewFinding[] {
    return rawFindings
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => ({
        severity: this.normalizeSeverity(String(f.severity ?? 'LOW')),
        file: String(f.file ?? 'unknown'),
        line: Number(f.line ?? 0),
        ruleId: f.ruleId ? String(f.ruleId) : undefined,
        message: String(f.message ?? ''),
        suggestion: String(f.suggestion ?? ''),
        autoFixable: f.autoFixable === true,
      }));
  }

  private normalizeSeverity(severity: string): ReviewFinding['severity'] {
    const valid: ReviewFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const upper = severity.toUpperCase();
    return valid.includes(upper as ReviewFinding['severity']) ? (upper as ReviewFinding['severity']) : 'LOW';
  }

  private extractAutoFixableIndices(
    findings: ReviewFinding[],
    explicitIndices?: number[]
  ): number[] {
    if (explicitIndices && Array.isArray(explicitIndices)) {
      return explicitIndices.filter((i) => i >= 0 && i < findings.length);
    }
    return findings
      .map((f, i) => (f.autoFixable ? i : -1))
      .filter((i) => i !== -1);
  }
}

export interface ReviewerReplyInput {
  /** 当前 MR 信息 */
  mr: MergeRequest;
  /** Reviewer 最初提出的 findings */
  originalFindings: ReviewFinding[];
  /** 该 discussion 下的全部历史评论 */
  threadNotes: Array<{ author: string; body: string; createdAt: string }>;
  /** 需要判断是否回复的目标评论 */
  targetNote: { author: string; body: string; createdAt: string };
}

export interface ReviewerReplyResult {
  /** 是否需要回复 */
  shouldReply: boolean;
  /** 回复正文（Markdown） */
  replyBody?: string;
  /** 判断理由 */
  reason: string;
}
