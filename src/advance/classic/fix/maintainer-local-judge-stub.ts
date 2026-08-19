/**
 * Maintainer 判别辅助的保守桩实现
 *
 * 当前行为：
 * - 所有辅助请求均回退为“不可靠”，不改变现有 Maintainer 逻辑
 * - 后续可替换为本地轻量模型实现，且无需修改调用方
 */

import type { MaintainerLocalJudge, LocalJudgeVerdict, SemanticReidentificationResult, StuckCorrectionResult, AlreadyFixedAssistanceResult } from './maintainer-local-judge.js';

export class ConservativeLocalJudgeStub implements MaintainerLocalJudge {
  /** 当前桩始终可用（避免调用方因“不可用”而改变流程），但判定均不可靠 */
  isAvailable(): boolean {
    return true;
  }

  reassessSemanticIdentity(
    currentFindingDescription: string,
    previousDecisionSummary: string,
    fileContextHint?: string,
  ): Promise<LocalJudgeVerdict | SemanticReidentificationResult> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，语义重识别由现有机制处理',
    });
  }

  adviseOnStuckProgress(
    findingDescription: string,
    recentProgressSummary: string,
    attemptedDirectionsSummary?: string,
  ): Promise<LocalJudgeVerdict | StuckCorrectionResult> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，卡点校正由现有熔断逻辑处理',
    });
  }

  assistAlreadyFixedCheck(
    findingDescription: string,
    currentCodeContextHint?: string,
  ): Promise<LocalJudgeVerdict | AlreadyFixedAssistanceResult> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，already-fixed 判定由现有机制处理',
    });
  }
}
