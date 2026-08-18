import type { ClassificationResult } from '../../types';

export interface SuggestInput {
  filePath: string;
  contentPreview?: string;
  classification: ClassificationResult;
  dedupRelation?: 'duplicate' | 'conflict' | 'related' | 'unrelated';
  relatedPath?: string;
}

/**
 * 根据分类与去重结果生成归档建议
 */
export function buildSuggestPrompt(input: SuggestInput): string {
  const contentSnippet = input.contentPreview
    ? input.contentPreview.length > 1000
      ? input.contentPreview.slice(0, 1000) + '\n...（内容已截断）'
      : input.contentPreview
    : '';

  return `你是一名归档策略专家。请根据文档的分类与去重结果，给出归档动作建议。

重要：你的回复正文必须且只能包含一个 JSON 对象，不要加 markdown 代码块、不要加解释、不要加思考过程。

可选动作：
- copy: 将源文件复制到程序已计算的归档路径（默认动作）
- ignore: 忽略此文件，不归档
- flag: 标记此文件需要人工关注，程序会复制到 flagged 子目录

决策边界：
- 目标路径已由程序计算并校验，你不要生成、修改或讨论路径。
- 当前输入是尚未归档的新文件，不要建议 organize。

JSON 字段要求：
- type: copy | ignore | flag
- rationale: 决策说明
- risk: low | medium | high（仅用于日志可见性，不影响执行）
- confidence: 0.0-1.0
- needsReview: boolean，是否需要人工复查

文件路径：${input.filePath}
分类：${input.classification.category}/${input.classification.docType}
摘要：${input.classification.summary}
去重关系：${input.dedupRelation ?? 'unrelated'}${input.relatedPath ? ` (${input.relatedPath})` : ''}
${
  contentSnippet
    ? `

内容预览：
${contentSnippet}`
    : ''
}

请直接输出如下格式的 JSON，不要任何其他内容：
{
  "type": "copy",
  "rationale": "...",
  "risk": "low",
  "confidence": 0.9,
  "needsReview": false
}`;
}

export interface ParsedSuggestResponse {
  type: 'copy' | 'ignore' | 'flag';
  rationale: string;
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  needsReview?: boolean;
}

export function parseSuggestResponse(text: string): ParsedSuggestResponse | null {
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
          const parsed = JSON.parse(cleaned.slice(i, j + 1));
          if (
            ['copy', 'ignore', 'flag'].includes(parsed.type) &&
            typeof parsed.rationale === 'string' &&
            ['low', 'medium', 'high'].includes(parsed.risk) &&
            typeof parsed.confidence === 'number' &&
            !Number.isNaN(parsed.confidence)
          ) {
            return {
              type: parsed.type as 'copy' | 'ignore' | 'flag',
              rationale: parsed.rationale,
              risk: parsed.risk as 'low' | 'medium' | 'high',
              confidence: Math.min(1, Math.max(0, parsed.confidence)),
              needsReview: Boolean(parsed.needsReview),
            };
          }
        } catch {
          // 不是有效 JSON，继续尝试下一个候选
        }
        break;
      }
    }
  }

  return null;
}
