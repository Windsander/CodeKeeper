/**
 * 默认分类列表
 */
export const DEFAULT_CATEGORIES = ['memory', 'sync', 'skill', 'review', 'design', 'weekly', 'other'];

/**
 * 默认文档类型列表
 */
export const DEFAULT_DOC_TYPES = ['design', 'spec', 'weekly', 'review', 'note', 'code', 'config', 'snippet', 'other'];

export interface ClassifyPromptOptions {
  categories?: string[];
  docTypes?: string[];
}

/**
 * 根据文件路径与内容生成分类 prompt
 */
export function buildClassifyPrompt(
  filePath: string,
  content: string,
  options: ClassifyPromptOptions = {}
): string {
  const categoryList = options.categories?.length ? options.categories.join(', ') : DEFAULT_CATEGORIES.join(', ');
  const docTypeList = options.docTypes?.length ? options.docTypes.join(', ') : DEFAULT_DOC_TYPES.join(', ');
  return `你是一名知识库管理员。请根据以下文件的路径和内容，判断其所属分类并提取关键信息。

要求：
- category: 从 [${categoryList}] 中选择最匹配的一个；如果没有匹配项，使用 \"other\"。
- docType: 从 [${docTypeList}] 中选择最匹配的一个文档类型；如果没有匹配项，使用 \"other\"。
- tags: 3-5 个关键词字符串数组。
- summary: 一句话摘要（50 字以内）。
- sections: 分节摘要数组。如果文档较长（超过 3 个自然段或包含多个标题），请提取 2-5 个关键节，每节包含 heading（标题/关键句）和 summary（30 字以内摘要）；短文档可为空数组。
- confidence: 整体置信度 0.0-1.0。

请严格按 JSON 输出，不要包含任何额外说明。

文件路径：${filePath}

内容前 3000 字符：
${content.slice(0, 3000)}

输出格式：
{
  \"category\": \"...\",
  \"docType\": \"...\",
  \"tags\": [\"...\"],
  \"summary\": \"...\",
  \"sections\": [
    { \"heading\": \"...\", \"summary\": \"...\", \"confidence\": 0.9 }
  ],
  \"confidence\": 0.95
}`;
}

export interface ParsedClassifyResponse {
  category: string;
  docType: string;
  tags: string[];
  summary: string;
  sections: Array<{ heading: string; summary: string; confidence: number }>;
  confidence: number;
}

/**
 * 解析分类结果，失败时返回 null
 */
export function parseClassifyResponse(text: string): ParsedClassifyResponse | null {
  try {
    const json = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    if (
      typeof parsed.category === 'string' &&
      typeof parsed.docType === 'string' &&
      Array.isArray(parsed.tags) &&
      typeof parsed.summary === 'string' &&
      typeof parsed.confidence === 'number'
    ) {
      const sections = Array.isArray(parsed.sections)
        ? parsed.sections
            .filter(
              (s: unknown) =>
                s && typeof (s as Record<string, unknown>).heading === 'string' &&
                typeof (s as Record<string, unknown>).summary === 'string'
            )
            .map((s: Record<string, unknown>) => ({
              heading: String(s.heading),
              summary: String(s.summary),
              confidence:
                typeof s.confidence === 'number' && !isNaN(s.confidence)
                  ? Math.min(1, Math.max(0, s.confidence))
                  : 0.8,
            }))
        : [];
      return {
        category: parsed.category,
        docType: parsed.docType,
        tags: parsed.tags.map(String),
        summary: parsed.summary,
        sections,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
      };
    }
    return null;
  } catch {
    return null;
  }
}
