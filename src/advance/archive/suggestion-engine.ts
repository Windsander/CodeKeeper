import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { LlmStructuredOutputError, type LlmClient } from '../llm/client';
import type { ToolDefinition } from '../llm/tool-types';
import { buildSuggestPrompt, parseSuggestResponse } from '../llm/prompts/suggest-prompt';
import type { ArchiveAction, ClassificationResult } from '../types';
import { logger } from '../../core/logger';
import { toFlaggedArchivePath } from './archive-path';

const SUGGEST_RESPONSE_SCHEMA: ToolDefinition['input_schema'] = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['copy', 'ignore', 'flag'] },
    rationale: { type: 'string' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needsReview: { type: 'boolean' },
  },
  required: ['type', 'rationale', 'risk', 'confidence', 'needsReview'],
  additionalProperties: false,
};

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
    if (
      classification.category === 'other' &&
      classification.docType === 'other' &&
      classification.confidence <= 0
    ) {
      return makeFlagAction(filePath, context.proposedArchivePath, '自动分类失败，等待人工复查');
    }

    const prompt = buildSuggestPrompt({
      filePath,
      contentPreview: context.contentPreview,
      classification,
      dedupRelation: context.dedupRelation,
      relatedPath: context.relatedPath ? basename(context.relatedPath) : undefined,
    });
    let text: string;
    try {
      text = await this.client.completeJson(
        prompt,
        '你是一名归档策略专家，只通过结构化 JSON 返回决策。',
        SUGGEST_RESPONSE_SCHEMA
      );
    } catch (error) {
      if (!(error instanceof LlmStructuredOutputError)) {
        throw error;
      }
      logger.warn(
        {
          fileName: basename(filePath),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        'LLM 建议请求失败'
      );
      return makeFlagAction(
        filePath,
        context.proposedArchivePath,
        'LLM 建议请求失败，等待人工复查'
      );
    }
    const parsed = parseSuggestResponse(text);

    if (parsed) {
      const type = parsed.needsReview ? 'flag' : parsed.type;
      return {
        id: makeActionId(filePath),
        sourcePath: filePath,
        type,
        reason: parsed.rationale,
        targetPath:
          type === 'ignore'
            ? undefined
            : type === 'flag'
              ? toFlaggedArchivePath(context.proposedArchivePath)
              : context.proposedArchivePath,
        relatedEntryId: context.relatedPath,
        risk: parsed.risk,
        confidence: parsed.confidence,
        createdAt: Date.now(),
      };
    }

    logger.warn({ fileName: basename(filePath), responseLength: text.length }, 'LLM 建议解析失败');
    return makeFlagAction(filePath, context.proposedArchivePath, 'LLM 建议解析失败，等待人工复查');
  }
}

function makeFlagAction(
  filePath: string,
  proposedArchivePath: string,
  reason: string
): ArchiveAction {
  return {
    id: makeActionId(filePath),
    sourcePath: filePath,
    type: 'flag',
    reason,
    targetPath: toFlaggedArchivePath(proposedArchivePath),
    risk: 'high',
    confidence: 0,
    createdAt: Date.now(),
  };
}

function makeActionId(filePath: string): string {
  return createHash('sha256').update(`${filePath}:${Date.now()}`).digest('hex').slice(0, 16);
}
