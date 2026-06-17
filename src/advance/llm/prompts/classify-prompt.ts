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

export interface FileMetadataForPrompt {
  sourcePath: string;
  fileName: string;
  extension: string;
  size: number;
  modifiedAt: number;
  header: string;
  headerHash: string;
  pathTokens: string[];
  dateHints: string[];
  estimatedCategory?: string;
  estimatedDocType?: string;
  heuristicConfidence: number;
}

/**
 * 根据文件路径与内容生成分类 prompt
 */
export function buildClassifyPrompt(
  filePath: string,
  metadata: FileMetadataForPrompt,
  contentPreview: string,
  options: ClassifyPromptOptions = {}
): string {
  const categoryList = options.categories?.length ? options.categories.join(', ') : DEFAULT_CATEGORIES.join(', ');
  const docTypeList = options.docTypes?.length ? options.docTypes.join(', ') : DEFAULT_DOC_TYPES.join(', ');

  const contentSection = contentPreview
    ? `\n内容前 1500 字符（供参考）：\n${contentPreview.slice(0, 1500)}`
    : '';

  return `你是一名知识库管理员。请根据以下文件元数据判断其所属分类并提取关键信息。

重要：你的回复正文必须且只能包含一个 JSON 对象，不要加 markdown 代码块、不要加解释、不要加思考过程。

JSON 字段要求：
- category: 从 [${categoryList}] 中选择最匹配的一个；如果没有匹配项，使用 "other"。
- docType: 从 [${docTypeList}] 中选择最匹配的一个文档类型；如果没有匹配项，使用 "other"。
- tags: 3-5 个关键词字符串数组。
- summary: 一句话摘要（50 字以内）。
- sections: 分节摘要数组。如果提供了内容预览且文档较长，请提取 2-5 个关键节，每节包含 heading（标题/关键句）和 summary（30 字以内摘要）；短文档可为空数组。
- confidence: 整体置信度 0.0-1.0。

文件路径：${filePath}
文件大小：${metadata.size} 字节
修改时间：${new Date(metadata.modifiedAt).toISOString()}
扩展名：${metadata.extension}
文件名关键词：${metadata.pathTokens.join(', ')}
日期线索：${metadata.dateHints.join(', ') || '无'}
路径启发分类：${metadata.estimatedCategory || '无'}
路径启发文档类型：${metadata.estimatedDocType || '无'}
启发置信度：${metadata.heuristicConfidence.toFixed(2)}
前 500 字符：${metadata.header.slice(0, 500)}${contentSection}

请直接输出如下格式的 JSON，不要任何其他内容：
{
  "category": "...",
  "docType": "...",
  "tags": ["..."],
  "summary": "...",
  "sections": [
    { "heading": "...", "summary": "...", "confidence": 0.9 }
  ],
  "confidence": 0.95
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
 * 从可能包含自然语言的文本中提取第一个结构完整的 JSON 对象
 */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/\s*```/g, '')
    .trim();

  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < cleaned.length; j++) {
      if (cleaned[j] === '{') depth++;
      else if (cleaned[j] === '}') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(i, j + 1)) as Record<string, unknown>;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/**
 * 解析分类结果，失败时返回 null
 */
export function parseClassifyResponse(text: string): ParsedClassifyResponse | null {
  const parsed = extractFirstJsonObject(text);
  if (!parsed) return null;

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
}
