/**
 * Maintainer 判别辅助的保守桩实现
 *
 * 当前行为：
 * - 所有辅助请求均回退为“不可靠”，不改变现有 Maintainer 逻辑
 * - 后续可替换为本地轻量模型实现，且无需修改调用方
 */

import type { MaintainerLocalJudge, LocalJudgeVerdict, SemanticReidentificationResult, StuckCorrectionResult, AlreadyFixedAssistanceResult, PreFilterScopeVerdict, PreFilterNonFindingVerdict } from './maintainer-local-judge.js';

export class ConservativeLocalJudgeStub implements MaintainerLocalJudge {
  /** 当前桩始终可用（避免调用方因“不可用”而改变流程），但判定均不可靠 */
  isAvailable(): boolean {
    return true;
  }

  reassessSemanticIdentity(
    _currentFindingDescription: string,
    _previousDecisionSummary: string,
    _fileContextHint?: string,
  ): Promise<LocalJudgeVerdict | SemanticReidentificationResult> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，语义重识别由现有机制处理',
    });
  }

  adviseOnStuckProgress(
    _findingDescription: string,
    _recentProgressSummary: string,
    _attemptedDirectionsSummary?: string,
  ): Promise<LocalJudgeVerdict | StuckCorrectionResult> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，卡点校正由现有熔断逻辑处理',
    });
  }

  assistAlreadyFixedCheck(
    _findingDescription: string,
    _currentCodeContextHint?: string,
  ): Promise<LocalJudgeVerdict | AlreadyFixedAssistanceResult> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，already-fixed 判定由现有机制处理',
    });
  }

  preFilterScope(
    _findingDescription: string,
    _findingFile?: string,
    _findingLine?: number,
  ): Promise<PreFilterScopeVerdict> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，scope 初筛由现有机制处理',
    });
  }

  preFilterNonFindingDiscussion(
    _discussionBody: string,
    _discussionNoteCount?: number,
  ): Promise<PreFilterNonFindingVerdict> {
    return Promise.resolve({
      kind: 'unreliable',
      reason: '本地判别辅助尚未启用，非 finding 过滤由现有机制处理',
    });
  }
}
