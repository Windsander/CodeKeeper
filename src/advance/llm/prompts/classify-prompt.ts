/**
 * 根据文件路径与内容生成分类 prompt
 */
export function buildClassifyPrompt(filePath: string, content: string, categories: string[]): string {
  const categoryList = categories.length > 0 ? categories.join(', ') : 'memory, sync, skill, review, design, weekly, other';
  return `你是一名知识库管理员。请根据以下文件的路径和内容，判断其所属分类。

要求：
- category: 从 [${categoryList}] 中选择最匹配的一个；如果没有匹配项，使用 "other"。
- docType: 文档类型，如 design, spec, weekly, review, note, code, config 等。
- tags: 3-5 个关键词，用逗号分隔。
- summary: 一句话摘要（50 字以内）。
- confidence: 置信度 0.0-1.0。

请严格按 JSON 输出，不要包含任何额外说明。

文件路径：${filePath}

内容前 2000 字符：
${content.slice(0, 2000)}

输出格式：
{
  "category": "...",
  "docType": "...",
  "tags": ["..."],
  "summary": "...",
  "confidence": 0.95
}`;
}

/**
 * 解析分类结果，失败时返回 null
 */
export function parseClassifyResponse(text: string) {
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
      return {
        category: parsed.category,
        docType: parsed.docType,
        tags: parsed.tags.map(String),
        summary: parsed.summary,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
      };
    }
    return null;
  } catch {
    return null;
  }
}
