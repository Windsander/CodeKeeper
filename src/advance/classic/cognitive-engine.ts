import type { LlmClient } from '../llm/client.js';
import type {
  CognitiveContext,
  CognitiveDecision,
  CognitiveDepth,
} from './fix/cognitive-types.js';

export interface CognitiveEngineOptions {
  llmClient: LlmClient;
}

/**
 * 认知引擎
 *
 * 把 Maintainer 的决策过程拆成可配置的多步认知循环：
 * - fast：观察 → 决策（1 次 LLM 调用）
 * - standard：观察 → 追问 → 生成候选方案 → 决策（2~3 次调用）
 * - deep：standard 全部步骤 + 执行后反思并记录到记忆
 */
export class CognitiveEngine {
  constructor(private readonly options: CognitiveEngineOptions) {}

  async decide(
    context: CognitiveContext,
    depth: CognitiveDepth = 'standard'
  ): Promise<CognitiveDecision> {
    if (depth === 'fast') {
      return this.decideFast(context);
    }
    // standard / deep 先使用 fast 兜底，后续任务会展开多步推理
    return this.decideFast(context);
  }

  private async decideFast(context: CognitiveContext): Promise<CognitiveDecision> {
    const prompt = this.buildFastPrompt(context);
    const raw = await this.options.llmClient.complete(
      prompt,
      '你是谨慎的代码维护助手。请只输出 JSON。'
    );
    return this.parseDecision(raw, context);
  }

  private buildFastPrompt(context: CognitiveContext): string {
    return [
      '## 文件路径',
      context.finding.file,
      '',
      '## 相关代码',
      '```',
      context.fileContent,
      '```',
      '',
      '## Reviewer 评论',
      context.originalComment,
      '',
      '## 解析出的 finding',
      `- 严重程度：${context.finding.severity}`,
      context.finding.ruleId ? `- 规则：${context.finding.ruleId}` : '',
      `- 行号：${context.finding.line}`,
      `- 问题描述：${context.finding.message}`,
      `- 修改建议：${context.finding.suggestion}`,
      '',
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map((m) => `- ${m}`).join('\n')}`
        : '',
      '',
      '请输出 JSON：',
      '{',
      '  "action": "fix" | "ask" | "ignore",',
      '  "reason": "简要说明理由",',
      '  "question": "如果 action=ask，填写问题",',
      '  "fixDescription": "如果 action=fix，可选描述",',
      '  "deleteFile": "如果 action=fix 且需要删除文件，填 true",',
      '  "scope": "trivial|local|cross-file",',
      '  "analysis": "对问题的分析",',
      '  "consideredOptions": ["方案1", "方案2"],',
      '  "reasoning": "最终选择该方案的原因",',
      '  "confidence": "high|medium|low"',
      '}',
    ].join('\n');
  }

  private parseDecision(raw: string, context: CognitiveContext): CognitiveDecision {
    const text = raw.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = jsonMatch ? jsonMatch[1].trim() : text;

    try {
      const parsed = JSON.parse(jsonText) as {
        action: string;
        reason?: string;
        question?: string;
        fixDescription?: string;
        deleteFile?: boolean;
        scope?: string;
        analysis?: string;
        consideredOptions?: string[];
        reasoning?: string;
        confidence?: string;
      };

      const base = this.normalizeBaseDecision(parsed, context);
      return {
        ...base,
        analysis: parsed.analysis ?? '未提供分析',
        consideredOptions: Array.isArray(parsed.consideredOptions)
          ? parsed.consideredOptions
          : [],
        reasoning: parsed.reasoning ?? base.reason,
        confidence: this.normalizeConfidence(parsed.confidence),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CognitiveEngine] 解析决策失败:', message, '原始响应:', raw);
      return {
        action: 'ask',
        reason: '无法解析 LLM 决策，需要 Reviewer 进一步说明',
        question: '我没有完全理解你的意思，能否再说得具体一些？',
        analysis: '决策解析失败',
        consideredOptions: [],
        reasoning: '决策解析失败，保守询问',
        confidence: 'low',
      };
    }
  }

  private normalizeBaseDecision(
    parsed: {
      action: string;
      reason?: string;
      question?: string;
      fixDescription?: string;
      deleteFile?: boolean;
      scope?: string;
    },
    _context: CognitiveContext
  ): {
    action: 'fix' | 'ask' | 'ignore';
    reason: string;
    question?: string;
    fixDescription?: string;
    deleteFile?: boolean;
    scope?: 'trivial' | 'local' | 'cross-file';
  } {
    const reason = parsed.reason ?? '未说明理由';
    switch (parsed.action) {
      case 'fix':
        return {
          action: 'fix',
          reason,
          fixDescription: parsed.fixDescription,
          deleteFile: parsed.deleteFile === true,
          scope: this.normalizeScope(parsed.scope),
        };
      case 'ask':
        return {
          action: 'ask',
          reason,
          question: parsed.question ?? '能否补充一下期望的修改方式或范围？',
        };
      case 'ignore':
        return { action: 'ignore', reason };
      default:
        return {
          action: 'ask',
          reason: `未知的 action: ${parsed.action}，需要 Reviewer 确认`,
          question: '我没有完全理解你的意思，能否再说得具体一些？',
        };
    }
  }

  private normalizeScope(scope?: string): 'trivial' | 'local' | 'cross-file' {
    if (scope === 'trivial' || scope === 'cross-file') return scope;
    return 'local';
  }

  private normalizeConfidence(confidence?: string): 'high' | 'medium' | 'low' {
    if (confidence === 'high' || confidence === 'low') return confidence;
    return 'medium';
  }
}
