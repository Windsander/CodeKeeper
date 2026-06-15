import { LlmClient } from '../llm/client';
import { buildClassifyPrompt, parseClassifyResponse, DEFAULT_CATEGORIES } from '../llm/prompts/classify-prompt';
import type { ClassificationResult } from '../types';

export interface ClassifierOptions {
  /** 自定义分类列表 */
  categories?: string[];
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
    const prompt = buildClassifyPrompt(filePath, content, categories);
    const text = await this.client.complete(prompt, '你是一名严谨的知识库管理员，只输出 JSON。');
    const parsed = parseClassifyResponse(text);

    if (parsed) {
      const accepted = this.options.categories ?? DEFAULT_CATEGORIES;
      const normalized = accepted.includes(parsed.category) ? parsed.category : 'other';
      return { ...parsed, category: normalized };
    }

    return {
      category: 'other',
      docType: 'note',
      tags: [],
      summary: '自动分类失败，等待人工 review',
      confidence: 0,
    };
  }
}
