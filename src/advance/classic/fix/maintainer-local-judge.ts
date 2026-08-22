/**
 * Maintainer 判别辅助抽象
 *
 * 目标（见本分支方案）：
 * - 在少数高杠杆语义判断点引入本地轻量判别辅助
 * - 不代替 Maintainer 大脑/Actor 的既有决策，仅作为辅助信号
 * - 不可信/不可用时必须无缝回退到现有机制
 */

export type LocalJudgeVerdict =
  | { kind: 'reliable'; value: boolean; reason: string }
  | { kind: 'unreliable'; reason: string };

export type PreFilterScopeVerdict =
  | { kind: 'reliable'; scope: 'trivial' | 'local' | 'cross-file' | 'needs-clarification'; reason: string }
  | { kind: 'unreliable'; reason: string };

export type PreFilterNonFindingVerdict =
  | { kind: 'reliable'; isProbablyNonFinding: boolean; reason: string }
  | { kind: 'unreliable'; reason: string };

/**
 * 语义重识别辅助的结果
 */
export interface SemanticReidentificationResult {
  /** 当前 finding 与之前记录的决策是否可能是同一语义问题 */
  likelySame: boolean;
  /** 判定依据 */
  reason: string;
  /** 置信程度，用于决定是否覆盖/复用历史决策 */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * 工具循环卡点校正辅助的结果
 */
export interface StuckCorrectionResult {
  /** 建议动作 */
  suggestion: 'continue' | 'refocus' | 'broaden' | 'stop';
  /** 建议理由 */
  reason: string;
  /** 是否建议停止当前方向的探索 */
  suggestStop: boolean;
}

/**
 * 已修复辅助的结果（可选的增强点）
 */
export interface AlreadyFixedAssistanceResult {
  /** 问题是否可能已经在当前代码中不存在 */
  likelyAlreadyFixed: boolean;
  /** 判定依据 */
  reason: string;
  /** 可选的最小证据片段（若提供，须经调用方 grounded 校验） */
  evidence?: string;
}

/**
 * 本地判别辅助的抽象接口
 *
 * 实现方可根据本部署能力选择本地 LLM 服务、MCP 桥或后续多模型配置；
 * 本接口不绑死具体后端。
 */
export interface MaintainerLocalJudge {
  /**
   * 服务当前是否可用
   */
  isAvailable(): boolean;

  /**
   * 语义重识别辅助
   *
   * 用在 MR HEAD 变化、文件结构变化后，判断当前 finding 是否与历史决策
   * 属于同一语义问题，从而避免已处理问题被重复回复/重复检查。
   */
  reassessSemanticIdentity(
    currentFindingDescription: string,
    previousDecisionSummary: string,
    fileContextHint?: string,
  ): Promise<LocalJudgeVerdict | SemanticReidentificationResult>;

  /**
   * 工具循环卡点校正辅助
   *
   * 在 FixToolLoop 探测到低效徘徊或长时间无实质进展时，可选调用，
   * 用于提前转向或收拢探索方向。
   */
  adviseOnStuckProgress(
    findingDescription: string,
    recentProgressSummary: string,
    attemptedDirectionsSummary?: string,
  ): Promise<LocalJudgeVerdict | StuckCorrectionResult>;

  /**
   * 已修复辅助（可选增强点）
   *
   * 在 already-fixed 判定阶段提供辅助信号。
   * 输出的证据必须经调用方 grounded 校验，不得直接覆盖现有结论。
   */
  assistAlreadyFixedCheck(
    findingDescription: string,
    currentCodeContextHint?: string,
  ): Promise<LocalJudgeVerdict | AlreadyFixedAssistanceResult>;

  /**
   * Scope 初筛辅助（中优先级位置）
   *
   * 在启发式规则尚未给出明确范围结论时，辅助判断一个 finding
   * 更可能属于 trivial / local / cross-file / needs-clarification。
   * 不可靠时返回不可靠，不改变现有范围判定。
   */
  preFilterScope(
    findingDescription: string,
    findingFile?: string,
    findingLine?: number,
  ): Promise<PreFilterScopeVerdict>;

  /**
   * 非 finding 讨论的语义过滤辅助（中优先级位置）
   *
   * 在 discussion 无法解析出具体文件/行号时，辅助判断该讨论是否
   * 很可能不是待逐条修复的代码问题（例如纯统计/汇总/提问_hint/误报指示等）。
   * 不可靠时返回不可靠，调用方继续走原有非 finding 处理路径。
   */
  preFilterNonFindingDiscussion(
    discussionBody: string,
    discussionNoteCount?: number,
  ): Promise<PreFilterNonFindingVerdict>;
}
