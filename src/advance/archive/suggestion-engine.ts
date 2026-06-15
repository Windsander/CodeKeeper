import { createHash } from 'node:crypto';
import type { LlmClient } from '../llm/client';
import { buildSuggestPrompt, parseSuggestResponse } from '../llm/prompts/suggest-prompt';
import type { ArchiveAction, ClassificationResult } from '../types';

export interface SuggestContext {
  dedupRelation?: 'duplicate' | 'conflict' | 'related' | 'unrelated';
  relatedPath?: string;
}

/**
 * 归档建议生成器：结合分类与去重结果输出 ArchiveAction
 */
export class SuggestionEngine {
  constructor(private client: LlmClient) {}

  async suggest(
    filePath: string,
    content: string,
    classification: ClassificationResult,
    context: SuggestContext = {}
  ): Promise<ArchiveAction> {
    const prompt = buildSuggestPrompt({
      filePath,
      content,
      classification,
      dedupRelation: context.dedupRelation,
      relatedPath: context.relatedPath,
    });
    const text = await this.client.complete(prompt, '你是一名归档策略专家，只输出 JSON。');
    const parsed = parseSuggestResponse(text);

    if (parsed) {
      return {
        id: makeActionId(filePath, content),
        entryId: filePath,
        type: parsed.type,
        reason: parsed.reason,
        targetPath: parsed.targetPath,
        relatedEntryId: parsed.relatedEntryId ?? context.relatedPath,
        risk: parsed.risk,
        confidence: parsed.confidence,
        createdAt: Date.now(),
      };
    }

    // 解析失败时回退为人工 review
    return {
      id: makeActionId(filePath, content),
      entryId: filePath,
      type: 'flag',
      reason: 'LLM 建议解析失败，需要人工 review',
      risk: 'high',
      confidence: 0,
      createdAt: Date.now(),
    };
  }
}

function makeActionId(filePath: string, content: string): string {
  // 使用 Date.now() 保证每次建议的 ID 唯一，避免同一文件多次建议产生冲突
  return createHash('sha256').update(`${filePath}:${content.slice(0, 200)}:${Date.now()}`).digest('hex').slice(0, 16);
}
