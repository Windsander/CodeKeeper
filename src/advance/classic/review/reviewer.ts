import { LlmClient } from '../../llm/client.js';
import type { MergeRequest, MrDiff, ReviewFinding, ReviewResult } from '../provider/types.js';

/**
 * ClassicReviewer 构造选项
 */
export interface ClassicReviewerOptions {
  /** LLM 客户端实例 */
  client: LlmClient;
  /** Token 预算上限 */
  tokenBudget: number;
  /** 评审规则文本 */
  rules: string;
}

/**
 * 基于 LlmClient 的 MR 代码评审器
 *
 * 使用 LLM 对 Merge Request 的 diff 进行自动化评审，
 * 输出结构化的发现项列表与总结。
 */
export class ClassicReviewer {
  constructor(private options: ClassicReviewerOptions) {}

  /**
   * 对 MR 的 diff 列表执行评审
   *
   * @param mr - 合并请求基本信息
   * @param diffs - 变更文件 diff 列表
   * @returns 评审结果
   */
  async review(mr: MergeRequest, diffs: MrDiff[]): Promise<ReviewResult> {
    if (diffs.length === 0) {
      return { findings: [], summary: 'No changes to review', autoFixable: [] };
    }

    const prompt = this.buildReviewPrompt(mr, diffs);
    const response = await this.options.client.complete(
      prompt,
      '你是严格的代码评审助手。请只输出 JSON。'
    );

    return this.parseReviewResponse(response);
  }

  /**
   * 为指定发现项生成自动修复代码
   *
   * @param filePath - 文件路径
   * @param originalContent - 原始文件内容
   * @param finding - 评审发现项
   * @returns 修复后的代码，或 null 表示无法生成
   */
  async generateFix(
    filePath: string,
    originalContent: string,
    finding: ReviewFinding
  ): Promise<string | null> {
    const prompt = this.buildFixPrompt(filePath, originalContent, finding);
    const response = await this.options.client.complete(prompt, undefined);
    return this.cleanFixOutput(response);
  }

  // ---------- 私有辅助方法 ----------

  /**
   * 构建评审 prompt
   */
  private buildReviewPrompt(mr: MergeRequest, diffs: MrDiff[]): string {
    const diffText = diffs
      .map(
        (d) =>
          `--- ${d.oldPath}\n+++ ${d.newPath}\n${d.newFile ? '(new file)' : ''}${d.deletedFile ? '(deleted)' : ''}\n${d.diff}`
      )
      .join('\n\n');

    return `请对以下 Merge Request 进行代码评审。

MR 标题: ${mr.title}
MR 描述: ${mr.description}
源分支: ${mr.sourceBranch} -> 目标分支: ${mr.targetBranch}

评审规则:
${this.options.rules}

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

  /**
   * 构建修复 prompt
   */
  private buildFixPrompt(filePath: string, originalContent: string, finding: ReviewFinding): string {
    return `请为以下代码问题生成修复后的代码。

文件: ${filePath}
问题: ${finding.message}
严重程度: ${finding.severity}
建议: ${finding.suggestion}

原始代码:
\`\`\`
${originalContent}
\`\`\`

请只输出修复后的完整文件内容，不要包含任何解释或 markdown 代码块标记。`;
  }

  /**
   * 解析 LLM 返回的 JSON 评审结果
   *
   * 解析失败时返回降级结果，包含原始响应以便排查。
   */
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

  /**
   * 从 markdown 代码块中提取 JSON 文本
   */
  private extractJsonFromMarkdown(text: string): string {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return text.trim();
  }

  /**
   * 规范化 findings 数组，确保每个元素符合 ReviewFinding 结构
   */
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

  /**
   * 规范化 severity 值，确保为有效枚举值
   */
  private normalizeSeverity(severity: string): ReviewFinding['severity'] {
    const valid: ReviewFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const upper = severity.toUpperCase();
    return valid.includes(upper as ReviewFinding['severity']) ? (upper as ReviewFinding['severity']) : 'LOW';
  }

  /**
   * 提取可自动修复的索引列表
   *
   * 优先使用 LLM 返回的 autoFixable 数组，
   * 若未提供则根据 finding.autoFixable 字段推导。
   */
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

  /**
   * 清理修复输出，去除 markdown 代码块包装
   */
  private cleanFixOutput(rawResponse: string): string | null {
    const trimmed = rawResponse.trim();
    if (!trimmed) {
      return null;
    }

    const codeBlockMatch = trimmed.match(/```(?:\w+)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    return trimmed;
  }
}
