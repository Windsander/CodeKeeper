import { createHash } from 'node:crypto';
import type { LlmClient } from '../llm/client';
import { buildSuggestPrompt, parseSuggestResponse } from '../llm/prompts/suggest-prompt';
import type { ArchiveAction, ClassificationResult } from '../types';
import { logger } from '../../core/logger';

export interface SuggestContext {
  dedupRelation?: 'duplicate' | 'conflict' | 'related' | 'unrelated';
  relatedPath?: string;
  proposedArchivePath: string;
  contentPreview?: string;
}

/**
 * 归档建议生成器：结合分类与去重结果输出 ArchiveAction
 */
export class SuggestionEngine {
  constructor(private client: LlmClient) {}

  async suggest(
    filePath: string,
    classification: ClassificationResult,
    context: SuggestContext
  ): Promise<ArchiveAction> {
    const prompt = buildSuggestPrompt({
      filePath,
      contentPreview: context.contentPreview,
      classification,
      dedupRelation: context.dedupRelation,
      relatedPath: context.relatedPath,
      proposedArchivePath: context.proposedArchivePath,
    });
    const text = await this.client.complete(prompt, '你是一名归档策略专家，只输出 JSON。');
    const parsed = parseSuggestResponse(text);

    if (parsed) {
      return {
        id: makeActionId(filePath),
        sourcePath: filePath,
        type: parsed.type,
        reason: parsed.rationale,
        targetPath: parsed.targetPath ?? context.proposedArchivePath,
        relatedEntryId: context.relatedPath,
        risk: parsed.risk,
        confidence: parsed.confidence,
        createdAt: Date.now(),
      };
    }

    logger.warn({ filePath, response: text.slice(0, 10000) }, 'LLM 建议解析失败');

    // 解析失败时回退为 flag，但仍复制到 flagged 目录
    return {
      id: makeActionId(filePath),
      sourcePath: filePath,
      type: 'flag',
      reason: 'LLM 建议解析失败，复制到 flagged 目录等待复查',
      targetPath: context.proposedArchivePath,
      risk: 'high',
      confidence: 0,
      createdAt: Date.now(),
    };
  }
}

function makeActionId(filePath: string): string {
  return createHash('sha256').update(`${filePath}:${Date.now()}`).digest('hex').slice(0, 16);
}
