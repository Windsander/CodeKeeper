/**
 * 跨文件修改规划器
 *
 * 对 scope 为 cross-file 的 finding，先让 LLM 判断需要改哪些文件、每处改什么，
 * 再由 MrFixAgent 逐文件生成 unified diff 并应用。
 */

import type { LlmClient } from '../../llm/client.js';
import type { ReviewFinding } from '../provider/types.js';
import type { FocusedContext } from './focused-context-builder.js';

export interface PlannedPatch {
  /** 需要修改的文件路径（相对项目根目录） */
  filePath: string;
  /** 该文件需要做什么修改 */
  description: string;
}

export interface CrossFilePlan {
  /** 为什么需要跨文件修改 */
  reason: string;
  /** 需要修改的文件列表 */
  patches: PlannedPatch[];
}

export interface CrossFilePlannerOptions {
  llmClient: LlmClient;
}

export class CrossFilePlanner {
  constructor(private readonly options: CrossFilePlannerOptions) {}

  async plan(finding: ReviewFinding, context: FocusedContext): Promise<CrossFilePlan> {
    const prompt = this.buildPrompt(finding, context);
    const raw = await this.options.llmClient.complete(
      prompt,
      '你是跨文件代码修改规划助手。请只输出 JSON，不要输出解释。'
    );
    return this.parseResponse(raw, finding.file);
  }

  private buildPrompt(finding: ReviewFinding, context: FocusedContext): string {
    return `你是一名谨慎的代码维护助手。请根据以下 Reviewer 意见和代码片段，判断本次修改会影响哪些文件，并给出每处需要做什么修改。

问题文件：${finding.file}
问题行号：${finding.line}
问题描述：${finding.message}
修改建议：${finding.suggestion}

当前文件相关代码（行 ${context.snippetStartLine}-${context.snippetEndLine}）：
${context.snippet}

请输出 JSON：
{
  "reason": "为什么需要跨文件修改",
  "patches": [
    {
      "filePath": "相对项目根目录的文件路径，例如 packages/a/src/types.ts",
      "description": "该文件需要做什么具体修改"
    }
  ]
}

注意：
- 只列出确实需要修改的文件；
- 第一个文件通常是 ${finding.file}；
- 如果不需要跨文件修改，返回空 patches 数组。`;
  }

  private parseResponse(raw: string, primaryFile: string): CrossFilePlan {
    const cleaned = this.extractJson(raw);
    try {
      const parsed = JSON.parse(cleaned) as {
        reason?: string;
        patches?: Array<{ filePath?: string; description?: string }>;
      };
      const patches = (parsed.patches ?? [])
        .filter((p): p is { filePath: string; description: string } =>
          Boolean(p.filePath && p.description)
        )
        .map((p) => ({
          filePath: p.filePath,
          description: p.description,
        }));

      // 如果没有规划出任何文件，至少保证主文件被处理
      if (patches.length === 0) {
        patches.push({
          filePath: primaryFile,
          description: '按 Reviewer 建议修改主文件',
        });
      }

      return {
        reason: parsed.reason ?? '未提供跨文件修改原因',
        patches,
      };
    } catch {
      return {
        reason: '规划解析失败，按主文件处理',
        patches: [{ filePath: primaryFile, description: '按 Reviewer 建议修改主文件' }],
      };
    }
  }

  private extractJson(raw: string): string {
    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();
    return raw.trim();
  }
}
