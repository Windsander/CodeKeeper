import type { ClassificationResult } from '../../types';

export interface SuggestInput {
  filePath: string;
  content: string;
  classification: ClassificationResult;
  dedupRelation?: 'duplicate' | 'conflict' | 'related' | 'unrelated';
  relatedPath?: string;
}

/**
 * 根据分类与去重结果生成归档建议
 */
export function buildSuggestPrompt(input: SuggestInput): string {
  return `根据以下文档的分类与去重结果，给出归档动作建议。

可选动作：move（移动到更合适路径）、merge（与已有文档合并）、create（新建归档）、ignore（忽略）、flag（标记人工 review）。

要求：
- type: move | merge | create | ignore | flag
- reason: 理由
- targetPath: 建议目标路径（move/create 时必填）
- relatedEntryId: 关联条目路径（merge 时必填）
- risk: low | medium | high
- confidence: 0.0-1.0

risk 判断：
- low: 明显应归档到标准路径，无冲突
- medium: 需要确认目标路径或分类
- high: 存在冲突、无法自动判断、可能覆盖重要内容

严格按 JSON 输出。

文件路径：${input.filePath}
分类：${input.classification.category}/${input.classification.docType}
摘要：${input.classification.summary}
去重关系：${input.dedupRelation ?? 'unrelated'}${input.relatedPath ? ` (${input.relatedPath})` : ''}

内容前 1500 字符：
${input.content.slice(0, 1500)}

输出格式：
{
  "type": "move",
  "reason": "...",
  "targetPath": "...",
  "relatedEntryId": "...",
  "risk": "low",
  "confidence": 0.9
}`;
}

export function parseSuggestResponse(text: string) {
  try {
    const json = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    if (
      ['move', 'merge', 'create', 'ignore', 'flag'].includes(parsed.type) &&
      typeof parsed.reason === 'string' &&
      ['low', 'medium', 'high'].includes(parsed.risk) &&
      typeof parsed.confidence === 'number'
    ) {
      return {
        type: parsed.type as 'move' | 'merge' | 'create' | 'ignore' | 'flag',
        reason: parsed.reason,
        targetPath: typeof parsed.targetPath === 'string' ? parsed.targetPath : undefined,
        relatedEntryId: typeof parsed.relatedEntryId === 'string' ? parsed.relatedEntryId : undefined,
        risk: parsed.risk as 'low' | 'medium' | 'high',
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
      };
    }
    return null;
  } catch {
    return null;
  }
}
