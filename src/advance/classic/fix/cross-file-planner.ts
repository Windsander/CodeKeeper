/**
 * 跨文件修改规划器
 *
 * 对 scope 为 cross-file 的 finding，先让 LLM 判断需要改哪些文件、每处改什么，
 * 再由 MrFixAgent 逐文件生成 unified diff 并应用。
 */

import type { LlmClient } from '../../llm/client.js';
import type { ReviewFinding } from '../provider/types.js';
import type { FocusedContext } from './focused-context-builder.js';
import { defaultPromptLoader, type PromptLoader } from '../../llm/prompts/loader.js';

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
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

export class CrossFilePlanner {
  private readonly promptLoader: PromptLoader;

  constructor(private readonly options: CrossFilePlannerOptions) {
    this.promptLoader = options.promptLoader ?? defaultPromptLoader;
  }

  async plan(finding: ReviewFinding, context: FocusedContext): Promise<CrossFilePlan> {
    const prompt = this.buildPrompt(finding, context);
    const system = `你是跨文件代码修改规划助手。${this.promptLoader.load('shared/json-only-constraint')}`;
    const raw = await this.options.llmClient.complete(prompt, system);
    return this.parseResponse(raw, finding.file);
  }

  private buildPrompt(finding: ReviewFinding, context: FocusedContext): string {
    return this.promptLoader.load('cross-file-plan', {
      findingFile: finding.file,
      findingLine: String(finding.line),
      findingMessage: finding.message,
      findingSuggestion: finding.suggestion,
      snippetStartLine: String(context.snippetStartLine),
      snippetEndLine: String(context.snippetEndLine),
      snippet: context.snippet,
    });
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
