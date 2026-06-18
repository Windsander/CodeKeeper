import type { ReviewFinding } from '../provider/types.js';

export type FixDecisionAction = 'fix' | 'skip' | 'defer';

export interface FixDecision {
  action: FixDecisionAction;
  reason: string;
}

export interface FixDecisionEngineOptions {
  /** 默认对 autoFixable finding 执行修复 */
  autoFixAutoFixable?: boolean;
}

/**
 * 修复决策引擎
 *
 * 根据 finding 的信息决定是否需要自动修复。
 * 当前实现为基于规则的快速决策，后续可扩展为 LLM 决策。
 */
export class FixDecisionEngine {
  constructor(private readonly options: FixDecisionEngineOptions = {}) {}

  decide(finding: ReviewFinding): FixDecision {
    const autoFix = this.options.autoFixAutoFixable ?? true;

    if (finding.autoFixable && autoFix) {
      return {
        action: 'fix',
        reason: 'finding 标记为可自动修复',
      };
    }

    if (finding.severity === 'CRITICAL' || finding.severity === 'HIGH') {
      return {
        action: 'defer',
        reason: `高风险 (${finding.severity}) 问题建议人工确认后再修复`,
      };
    }

    return {
      action: 'skip',
      reason: '未标记为可自动修复，跳过自动修复',
    };
  }
}
