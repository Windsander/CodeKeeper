/**
 * 基于 LlmClient 的轻量判别辅助实现
 *
 * 目标：
 * - 在少数高杠杆语义判断点提供结构化辅助判别
 * - 使用现有的 LlmClient，调用小 prompt、小输出
 * - 不可靠/失败时回退为不可靠，不改变 Maintainer 既有行为
 */

import { LlmClient } from '../../llm/client.js';
import type {
  MaintainerLocalJudge,
  LocalJudgeVerdict,
  SemanticReidentificationResult,
  StuckCorrectionResult,
  AlreadyFixedAssistanceResult,
} from './maintainer-local-judge.js';

interface ReidentifyPromptPayload {
  currentDescription: string;
  previousDecisionSummary: string;
  fileContextHint?: string;
}

interface StuckPromptPayload {
  findingDescription: string;
  recentProgressSummary: string;
  attemptedDirectionsSummary?: string;
}

interface AlreadyFixedPromptPayload {
  findingDescription: string;
  currentCodeContextHint?: string;
}

/**
 * 基于 LlmClient 的 Maintainer 判别辅助实现
 */
export class LlmMaintainerLocalJudge implements MaintainerLocalJudge {
  constructor(private llmClient: LlmClient) {}

  isAvailable(): boolean {
    return true;
  }

  async reassessSemanticIdentity(
    currentFindingDescription: string,
    previousDecisionSummary: string,
    fileContextHint?: string,
  ): Promise<LocalJudgeVerdict | SemanticReidentificationResult> {
    const payload: ReidentifyPromptPayload = {
      currentDescription: currentFindingDescription,
      previousDecisionSummary,
      fileContextHint,
    };
    try {
      const json = await this.llmClient.completeJson(
        this.buildReidentifyPrompt(payload),
        this.reidentifySystem(),
        {
          type: 'object',
          properties: {
            likelySame: { type: 'boolean' },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            reason: { type: 'string' },
          },
          required: ['likelySame', 'confidence', 'reason'],
        },
      );
      const body = this.parseSimpleJson(json);
      if (!body || typeof body.likelySame !== 'boolean') {
        return {
          kind: 'unreliable',
          reason: 'LLM 返回了不可解析的语义重识别结果',
        };
      }
      const confidence = this.normalizeConfidence(body.confidence);
      return {
        likelySame: body.likelySame,
        confidence,
        reason: body.reason ?? '',
      };
    } catch (error) {
      return {
        kind: 'unreliable',
        reason: this.wrapError(error),
      };
    }
  }

  async adviseOnStuckProgress(
    findingDescription: string,
    recentProgressSummary: string,
    attemptedDirectionsSummary?: string,
  ): Promise<LocalJudgeVerdict | StuckCorrectionResult> {
    const payload: StuckPromptPayload = {
      findingDescription,
      recentProgressSummary,
      attemptedDirectionsSummary,
    };
    try {
      const json = await this.llmClient.completeJson(
        this.buildStuckPrompt(payload),
        this.stuckSystem(),
        {
          type: 'object',
          properties: {
            suggestion: {
              type: 'string',
              enum: ['continue', 'refocus', 'broaden', 'stop'],
            },
            suggestStop: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['suggestion', 'suggestStop', 'reason'],
        },
      );
      const body = this.parseSimpleJson(json);
      if (!body || !['continue', 'refocus', 'broaden', 'stop'].includes(body.suggestion)) {
        return {
          kind: 'unreliable',
          reason: 'LLM 返回了不可解析的卡点校正结果',
        };
      }
      return {
        suggestion: body.suggestion as StuckCorrectionResult['suggestion'],
        suggestStop: Boolean(body.suggestStop),
        reason: body.reason ?? '',
      };
    } catch (error) {
      return {
        kind: 'unreliable',
        reason: this.wrapError(error),
      };
    }
  }

  async assistAlreadyFixedCheck(
    findingDescription: string,
    currentCodeContextHint?: string,
  ): Promise<LocalJudgeVerdict | AlreadyFixedAssistanceResult> {
    const payload: AlreadyFixedPromptPayload = {
      findingDescription,
      currentCodeContextHint,
    };
    try {
      const json = await this.llmClient.completeJson(
        this.buildAlreadyFixedPrompt(payload),
        this.alreadyFixedSystem(),
        {
          type: 'object',
          properties: {
            likelyAlreadyFixed: { type: 'boolean' },
            reason: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['likelyAlreadyFixed', 'reason'],
        },
      );
      const body = this.parseSimpleJson(json);
      if (!body || typeof body.likelyAlreadyFixed !== 'boolean') {
        return {
          kind: 'unreliable',
          reason: 'LLM 返回了不可解析的 already-fixed 辅助结果',
        };
      }
      return {
        likelyAlreadyFixed: body.likelyAlreadyFixed,
        reason: body.reason ?? '',
        evidence: body.evidence,
      };
    } catch (error) {
      return {
        kind: 'unreliable',
        reason: this.wrapError(error),
      };
    }
  }

  // ---------- 提示构造 ----------

  private buildReidentifyPrompt(payload: ReidentifyPromptPayload): string {
    const ctx = payload.fileContextHint ? `\n\n当前文件上下文提示：\n${payload.fileContextHint}` : '';
    return [
      '你正在帮助维护者判断：同一个代码审查问题是否可能已经在之前的轮次中被处理过。',
      '请根据当前发现描述和之前决策摘要，判断二者是否可能是同一个语义问题。',
      '',
      '当前发现描述：',
      payload.currentDescription,
      '',
      '之前决策摘要：',
      payload.previousDecisionSummary,
      ctx,
      '',
      '规则：',
      '- 如果之前的决策是 ignore/ignore(alreadyFixed)，且当前描述表达的是同样的意图/位置/问题，请倾向认为是同一语义问题。',
      '- 如果当前描述明显涉及不同问题、不同意图、不同位置，则不应该认为是同一语义问题。',
      '- 仅凭行号相同不足以断定同一语义问题；行号不同也不应直接否定同一语义问题。',
      '- 如果信息不足以判断，请返回 likelySame=false 并且 confidence=low。',
      '',
      '请返回 JSON，包含 likelySame(boolean)、confidence(one of high/medium/low)、reason(字符串)。',
    ].join('\n');
  }

  private buildStuckPrompt(payload: StuckPromptPayload): string {
    const attempted = payload.attemptedDirectionsSummary
      ? `\n\n已尝试的方向总结：\n${payload.attemptedDirectionsSummary}`
      : '';
    return [
      '你正在帮助维护者判断：当前修复循环是否应该继续当前方向、换范围、扩大范围，或收拢尝试。',
      '',
      '问题描述：',
      payload.findingDescription,
      '',
      '最近进度总结：',
      payload.recentProgressSummary,
      attempted,
      '',
      '建议动作之一：',
      '- continue：当前方向仍有意义，继续。',
      '- refocus：当前方向不集中，建议缩小/重新聚焦到更明确的目标。',
      '- broaden：当前范围太窄，建议扩大到更多相关文件/行。',
      '- stop：当前信息下不再继续有意义，建议收拢或换方式。',
      '',
      '请返回 JSON，包含 suggestion(one of continue/refocus/broaden/stop)、suggestStop(boolean)、reason(字符串)。',
    ].join('\n');
  }

  private buildAlreadyFixedPrompt(payload: AlreadyFixedPromptPayload): string {
    const ctx = payload.currentCodeContextHint
      ? `\n\n当前代码上下文提示：\n${payload.currentCodeContextHint}`
      : '';
    return [
      '你正在帮助维护者判断：某个审查问题是否已经在当前代码中不再存在。',
      '',
      '问题描述：',
      payload.findingDescription,
      ctx,
      '',
      '请回答：该问题是否可能已经在当前代码中不再存在。',
      '只返回 JSON，包含：',
      '- likelyAlreadyFixed(boolean)',
      '- reason(字符串)',
      '- evidence(可选字符串，仅在你确信该片段能作为最小证据时提供)',
      '',
      '注意：如果信息不足，不要武断返回 already-fixed。',
    ].join('\n');
  }

  // ---------- system / helper ----------

  private reidentifySystem(): string {
    return '你是一个保守的语义重识别辅助。目标是帮助判断同一语义问题是否已被处理，而不是直接代替人类决策。只有在理由充分时才标记 likelySame=true，并把置信度控制在 reasonable 范围。';
  }

  private stuckSystem(): string {
    return '你是一个保守的卡点校正辅助。不要鼓励无限继续；如果信息不足或方向不明确，倾向于 suggestStop=true。';
  }

  private alreadyFixedSystem(): string {
    return '你是一个保守的 already-fixed 辅助。只在有理由时标记 likelyAlreadyFixed=true，且不要超过你能从输入中看到的范围。';
  }

  private parseSimpleJson(text: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
    if (value === 'high' || value === 'medium' || value === 'low') {
      return value as 'high' | 'medium' | 'low';
    }
    return 'low';
  }

  private wrapError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `LLM 判别辅助失败: ${message}`;
  }
}
