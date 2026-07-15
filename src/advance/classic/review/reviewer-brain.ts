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
import { defaultPromptLoader, type PromptLoader } from '../../llm/prompts/loader.js';

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
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

/**
 * ReviewerBrain
 *
 * Reviewer 的决策大脑：根据 MR diff、评审规则、项目背景，
 * 由 LLM 输出结构化的 findings 和整体 summary，
 * 并判断是否需要回复别人对评审结论的评论。
 */
export class ReviewerBrain {
  private readonly promptLoader: PromptLoader;

  constructor(private readonly options: ReviewerBrainOptions) {
    this.promptLoader = options.promptLoader ?? defaultPromptLoader;
  }

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
      this.promptLoader.load('reviewer-system')
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
      this.promptLoader.load('reviewer-system')
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

    return this.promptLoader.load('reviewer-review-task', {
      mrTitle: mr.title,
      mrDescription: mr.description ?? '',
      mrSourceBranch: mr.sourceBranch,
      mrTargetBranch: mr.targetBranch,
      rules: this.options.rules,
      soulSection,
      contextSection,
      recalledContext,
      diffText,
    });
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

    return this.promptLoader.load('reviewer-reply-task', {
      mrTitle: input.mr.title,
      mrDescription: input.mr.description ?? '',
      mrSourceBranch: input.mr.sourceBranch,
      mrTargetBranch: input.mr.targetBranch,
      findingsText: findingsText || '（无结构化 findings）',
      notesText,
      recalledContext,
      targetAuthor: input.targetNote.author,
      targetCreatedAt: input.targetNote.createdAt,
      targetBody: input.targetNote.body,
      rules: this.options.rules,
      soulSection,
      contextSection,
    });
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
