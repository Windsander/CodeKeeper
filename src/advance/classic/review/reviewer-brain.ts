import { LlmClient } from '../../llm/client.js';
import type { MergeRequest, MrDiff, ReviewFinding, ReviewResult } from '../provider/types.js';
import type { IMemoryClient } from '../memory/types.js';

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
}

/**
 * ReviewerBrain
 *
 * Reviewer 的决策大脑：根据 MR diff、评审规则、项目背景，
 * 由 LLM 输出结构化的 findings 和整体 summary。
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

    const prompt = this.buildReviewPrompt(mr, diffs);
    const response = await this.options.llmClient.complete(
      prompt,
      '你是严格的代码评审助手。请只输出 JSON。'
    );

    const result = this.parseReviewResponse(response);

    if (this.options.memoryClient) {
      await this.options.memoryClient.recordReview({
        mrIid: mr.iid,
        title: mr.title,
        findingsCount: result.findings.length,
        summary: result.summary,
      });
    }

    return result;
  }

  private buildReviewPrompt(mr: MergeRequest, diffs: MrDiff[]): string {
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
${this.options.rules}${soulSection}${contextSection}

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
    } catch {
      return {
        findings: [],
        summary: '评审响应解析失败，请检查 LLM 输出格式',
        autoFixable: [],
        rawResponse,
      };
    }
  }

  private extractJsonFromMarkdown(text: string): string {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return text.trim();
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
