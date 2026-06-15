import { LlmClient } from '../llm/client';
import { buildClassifyPrompt, parseClassifyResponse, DEFAULT_CATEGORIES, DEFAULT_DOC_TYPES } from '../llm/prompts/classify-prompt';
import type { ClassificationResult } from '../types';

export interface ClassifierOptions {
  /** 自定义分类列表 */
  categories?: string[];
  /** 自定义文档类型列表 */
  docTypes?: string[];
}

/**
 * 文档分类器：基于 LLM 判断文档领域与类型
 */
export class DocumentClassifier {
  constructor(
    private client: LlmClient,
    private options: ClassifierOptions = {}
  ) {}

  async classify(filePath: string, content: string): Promise<ClassificationResult> {
    const categories = this.options.categories ?? [];
    const docTypes = this.options.docTypes ?? [];
    const prompt = buildClassifyPrompt(filePath, content, { categories, docTypes });
    const text = await this.client.complete(prompt, '你是一名严谨的知识库管理员，只输出 JSON。');
    const parsed = parseClassifyResponse(text);

    if (parsed) {
      const acceptedCategories = categories.length > 0 ? categories : DEFAULT_CATEGORIES;
      const acceptedDocTypes = docTypes.length > 0 ? docTypes : DEFAULT_DOC_TYPES;
      const normalizedCategory = acceptedCategories.includes(parsed.category) ? parsed.category : 'other';
      const normalizedDocType = acceptedDocTypes.includes(parsed.docType) ? parsed.docType : 'other';
      return {
        category: normalizedCategory,
        docType: normalizedDocType,
        tags: parsed.tags,
        summary: parsed.summary,
        sections: parsed.sections,
        confidence: parsed.confidence,
      };
    }

    return {
      category: 'other',
      docType: 'other',
      tags: [],
      summary: '自动分类失败，等待人工 review',
      sections: [],
      confidence: 0,
    };
  }
}
