export interface DedupInput {
  sourcePath: string;
  sourceContent: string;
  candidatePath: string;
  candidateContent: string;
}

/**
 * 判断两份文档是否重复或冲突
 */
export function buildDedupPrompt(input: DedupInput): string {
  return `判断以下两份文档的关系。选项：duplicate（内容重复）、conflict（内容冲突）、related（相关但不重复）、unrelated（无关）。

要求：
- relation: duplicate | conflict | related | unrelated
- reason: 一句话理由
- confidence: 0.0-1.0

严格按 JSON 输出。

文档 A: ${input.sourcePath}
${input.sourceContent.slice(0, 1500)}

---

文档 B: ${input.candidatePath}
${input.candidateContent.slice(0, 1500)}

输出格式：
{
  "relation": "...",
  "reason": "...",
  "confidence": 0.85
}`;
}

export function parseDedupResponse(text: string) {
  try {
    const json = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);
    if (
      ['duplicate', 'conflict', 'related', 'unrelated'].includes(parsed.relation) &&
      typeof parsed.reason === 'string' &&
      typeof parsed.confidence === 'number'
    ) {
      return {
        relation: parsed.relation as 'duplicate' | 'conflict' | 'related' | 'unrelated',
        reason: parsed.reason,
        confidence: Math.min(1, Math.max(0, parsed.confidence)),
      };
    }
    return null;
  } catch {
    return null;
  }
}
