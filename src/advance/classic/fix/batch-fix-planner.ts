/**
 * Discussion 级批量修复规划器
 *
 * 对同一条 discussion 中解析出的多个 finding，统一交给 LLM 做一次跨文件规划，
 * 输出一组标准 unified diff patch，避免逐个 fixing 导致多次提交或局部修改割裂。
 */

import type { ReviewFinding } from '../provider/types.js';
import { LlmClient } from '../../llm/client.js';

export interface BatchFixInput {
  /** 待统一修复的 finding 列表 */
  findings: ReviewFinding[];
  /** 每个 finding 对应的文件完整内容（key 为文件相对路径） */
  fileContents: Record<string, string>;
  /** 原始 discussion 评论，用于理解 Reviewer 整体意图 */
  originalComment: string;
}

export interface BatchFixPatch {
  /** 目标文件相对路径 */
  filePath: string;
  /** 标准 unified diff 补丁 */
  patch: string;
}

export interface BatchFixPlan {
  /** 规划说明 */
  reason: string;
  /** 按文件组织的补丁列表 */
  patches: BatchFixPatch[];
}

export interface BatchFixPlannerOptions {
  llmClient: LlmClient;
}

export class BatchFixPlanner {
  constructor(private readonly options: BatchFixPlannerOptions) {}

  /**
   * 为同一条 discussion 的多个 finding 生成统一修复计划
   */
  async plan(input: BatchFixInput): Promise<BatchFixPlan> {
    const prompt = this.buildPrompt(input);
    const response = await this.options.llmClient.complete(
      prompt,
      '你是代码维护助手。请只输出 JSON，不要输出解释。'
    );
    return this.parsePlan(response);
  }

  private buildPrompt(input: BatchFixInput): string {
    const findingSections = input.findings
      .map(
        (f, idx) =>
          `### Finding ${idx + 1}\n- 文件：${f.file}\n- 行号：${f.line}\n- 严重程度：${f.severity}\n- 规则：${f.ruleId ?? '无'}\n- 问题：${f.message}\n- 建议：${f.suggestion}`
      )
      .join('\n\n');

    const fileSections = Object.entries(input.fileContents)
      .map(
        ([path, content]) =>
          `## 文件：${path}\n\`\`\`\n${content}\n\`\`\``
      )
      .join('\n\n');

    return `请根据 Reviewer 在 MR discussion 中提出的所有问题，生成一份统一的修复计划。

## Reviewer 原评论
${input.originalComment}

## 需要修复的问题
${findingSections}

## 相关文件完整内容
${fileSections}

## 输出要求
请输出 JSON：
{
  "reason": "简要说明整体修复思路",
  "patches": [
    {
      "filePath": "相对路径",
      "patch": "标准 unified diff 补丁（包含 diff --git、---、+++、@@ 行）"
    }
  ]
}

注意：
- 每个 patch 必须是标准 unified diff 格式。
- hunk 行号必须对应上面给出的完整文件内容。
- 只修改与问题相关的行，保持补丁最小化。
- 同一个文件的多处修改可以合并到一个 patch 的多个 hunk 中，也可以分成多个 patch。
- 如果某个 finding 无法安全修复，可以省略对应的 patch，并在 reason 中说明。`;
  }

  private parsePlan(raw: string): BatchFixPlan {
    const cleaned = this.extractJson(raw);
    try {
      const parsed = JSON.parse(cleaned) as {
        reason?: string;
        patches?: Array<{ filePath?: string; patch?: string }>;
      };

      const patches = (parsed.patches ?? [])
        .filter((p): p is { filePath: string; patch: string } =>
          typeof p.filePath === 'string' && p.filePath.length > 0 &&
          typeof p.patch === 'string' && p.patch.length > 0
        )
        .map((p) => ({
          filePath: p.filePath.replace(/\\/g, '/'),
          patch: p.patch,
        }));

      return {
        reason: parsed.reason ?? '未说明修复思路',
        patches,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[BatchFixPlanner] 解析 LLM 批量修复计划失败: ${message}`);
      return { reason: 'LLM 未返回有效计划', patches: [] };
    }
  }

  private extractJson(text: string): string {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();
    return text.trim();
  }
}
