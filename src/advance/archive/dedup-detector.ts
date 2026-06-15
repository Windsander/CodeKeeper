import type { LlmClient } from '../llm/client';
import { buildDedupPrompt, parseDedupResponse } from '../llm/prompts/dedup-prompt';

export interface DedupCandidate {
  filePath: string;
  contentHash: string;
  content: string;
}

export interface DedupResult {
  /** 关系类型 */
  relation: 'duplicate' | 'conflict' | 'related' | 'unrelated';
  /** 最相关的候选路径 */
  relatedPath?: string;
  /** 理由 */
  reason: string;
  /** 置信度 */
  confidence: number;
}

export interface DedupDetectorOptions {
  /** 最多对比候选数，默认 5 */
  maxCandidates?: number;
  /** 置信度阈值，低于此视为 unrelated */
  threshold?: number;
}

/**
 * 去重/冲突检测器：先按哈希快速匹配，再对候选调用 LLM
 */
export class DedupDetector {
  constructor(
    private client: LlmClient,
    private options: DedupDetectorOptions = {}
  ) {}

  async detect(source: DedupCandidate, candidates: DedupCandidate[]): Promise<DedupResult> {
    const maxCandidates = this.options.maxCandidates ?? 5;
    const threshold = this.options.threshold ?? 0.7;

    // 快速路径：哈希完全相同的直接判定为重复
    const exactMatch = candidates.find((c) => c.contentHash === source.contentHash);
    if (exactMatch) {
      return {
        relation: 'duplicate',
        relatedPath: exactMatch.filePath,
        reason: '内容哈希完全一致',
        confidence: 1,
      };
    }

    // 仅对比最近的候选
    const limited = candidates.slice(0, maxCandidates);
    let best: DedupResult = { relation: 'unrelated', reason: '未找到相关候选', confidence: 0 };

    for (const candidate of limited) {
      const prompt = buildDedupPrompt({
        sourcePath: source.filePath,
        sourceContent: source.content,
        candidatePath: candidate.filePath,
        candidateContent: candidate.content,
      });
      const text = await this.client.complete(prompt, '你是一名文档去重专家，只输出 JSON。');
      const parsed = parseDedupResponse(text);
      if (!parsed) continue;
      if (parsed.confidence > best.confidence) {
        best = { ...parsed, relatedPath: candidate.filePath };
      }
      if (best.relation === 'duplicate' && best.confidence >= threshold) {
        break;
      }
    }

    if (best.confidence < threshold) {
      return { relation: 'unrelated', reason: '置信度不足，视为无关', confidence: best.confidence };
    }
    return best;
  }
}
