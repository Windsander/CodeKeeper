import { basename } from 'node:path';
import { LlmStructuredOutputError, type LlmClient } from '../llm/client';
import type { ToolDefinition } from '../llm/tool-types';
import {
  buildClassifyPrompt,
  parseClassifyResponse,
  DEFAULT_CATEGORIES,
  DEFAULT_DOC_TYPES,
} from '../llm/prompts/classify-prompt';
import { extractMetadata, type FileMetadata } from './metadata-extractor';
import type { ClassificationResult } from '../types';
import { logger } from '../../core/logger';

export interface ClassifierOptions {
  /** 自定义分类列表 */
  categories?: string[];
  /** 自定义文档类型列表 */
  docTypes?: string[];
  /** 启发置信度阈值，达到此值则跳过 LLM */
  heuristicThreshold?: number;
}

/**
 * 文档分类器：优先基于元数据启发，必要时调用 LLM
 */
export class DocumentClassifier {
  constructor(
    private client: LlmClient,
    private options: ClassifierOptions = {}
  ) {}

  async classify(filePath: string, content: string): Promise<ClassificationResult> {
    const categories = this.options.categories ?? [];
    const docTypes = this.options.docTypes ?? [];
    const threshold = this.options.heuristicThreshold ?? 0.8;

    const metadata = extractMetadata(filePath);

    // 启发置信度足够高时，直接返回启发结果
    if (
      metadata.estimatedCategory &&
      metadata.estimatedDocType &&
      metadata.heuristicConfidence >= threshold
    ) {
      return {
        category: metadata.estimatedCategory,
        docType: metadata.estimatedDocType,
        tags: metadata.pathTokens.slice(0, 5),
        summary: `基于路径/文件名启发分类：${metadata.estimatedCategory}/${metadata.estimatedDocType}`,
        sections: [],
        confidence: metadata.heuristicConfidence,
      };
    }

    // 否则调用 LLM，优先只给 metadata，必要时给 content preview
    const contentPreview = content.slice(0, 1500);
    const promptMetadata = {
      ...metadata,
      sourcePath: metadata.fileName,
      pathTokens: tokenizeFileName(metadata.fileName),
    };
    const prompt = buildClassifyPrompt(metadata.fileName, promptMetadata, contentPreview, {
      categories,
      docTypes,
    });
    const acceptedCategories = categories.length > 0 ? categories : DEFAULT_CATEGORIES;
    const acceptedDocTypes = docTypes.length > 0 ? docTypes : DEFAULT_DOC_TYPES;
    let text: string;
    try {
      text = await this.client.completeJson(
        prompt,
        '你是一名严谨的知识库管理员，只通过结构化 JSON 返回分类结果。',
        buildClassificationSchema(acceptedCategories, acceptedDocTypes)
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
        'LLM 分类请求失败'
      );
      return fallbackClassification();
    }
    const parsed = parseClassifyResponse(text);

    if (parsed) {
      const normalizedCategory = acceptedCategories.includes(parsed.category)
        ? parsed.category
        : 'other';
      const normalizedDocType = acceptedDocTypes.includes(parsed.docType)
        ? parsed.docType
        : 'other';
      return {
        category: normalizedCategory,
        docType: normalizedDocType,
        tags: parsed.tags,
        summary: parsed.summary,
        sections: parsed.sections,
        confidence: parsed.confidence,
      };
    }

    logger.warn({ fileName: basename(filePath), responseLength: text.length }, 'LLM 分类解析失败');
    return fallbackClassification();
  }

  /**
   * 仅提取元数据（供 pipeline 判断是否需要读取全文）
   */
  extractMetadata(filePath: string): FileMetadata {
    return extractMetadata(filePath);
  }
}

function buildClassificationSchema(
  categories: string[],
  docTypes: string[]
): ToolDefinition['input_schema'] {
  return {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...new Set([...categories, 'other'])] },
      docType: { type: 'string', enum: [...new Set([...docTypes, 'other'])] },
      tags: {
        type: 'array',
        items: { type: 'string' },
        minItems: 0,
        maxItems: 5,
      },
      summary: { type: 'string', maxLength: 100 },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            summary: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['heading', 'summary', 'confidence'],
          additionalProperties: false,
        },
        maxItems: 5,
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['category', 'docType', 'tags', 'summary', 'sections', 'confidence'],
    additionalProperties: false,
  };
}

function fallbackClassification(): ClassificationResult {
  return {
    category: 'other',
    docType: 'other',
    tags: [],
    summary: '自动分类失败，等待人工 review',
    sections: [],
    confidence: 0,
  };
}

function tokenizeFileName(fileName: string): string[] {
  return fileName
    .split(/[_\-.]+/)
    .map(part => part.toLowerCase())
    .filter(part => part.length > 1 && !/^\d+$/.test(part));
}
