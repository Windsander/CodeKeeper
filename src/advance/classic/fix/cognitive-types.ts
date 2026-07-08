import type { ReviewFinding } from '../provider/types.js';
import type { MaintainerDecision } from './maintainer-brain.js';

/**
 * 认知深度：控制 Maintainer 决策前推理的步数与 token 消耗
 */
export type CognitiveDepth = 'fast' | 'standard' | 'deep';

/**
 * MR 级上下文摘要
 */
export interface MrContext {
  /** MR 内部编号 */
  iid: number;
  /** MR 标题 */
  title: string;
  /** 源分支 */
  sourceBranch: string;
  /** 目标分支 */
  targetBranch: string;
  /** MR 描述 */
  description: string;
  /** diff 行数摘要 */
  diffSummary: string;
  /** 变更文件列表 */
  changedFiles: string[];
}

/**
 * 输入给认知引擎的完整上下文
 */
export interface CognitiveContext {
  /** 当前待处理的 finding */
  finding: ReviewFinding;
  /** finding 所在文件完整内容（或聚焦后的内容） */
  fileContent: string;
  /** 原始 Reviewer 评论 */
  originalComment: string;
  /** MR 级上下文 */
  mrContext: MrContext;
  /** 同 MR 其他相关 findings */
  relatedFindings: ReviewFinding[];
  /** 已召回的记忆文本列表 */
  recalledMemories: string[];
  /** Reviewer 偏好摘要（可选） */
  reviewerProfile?: string;
  /** 项目上下文（可选） */
  projectContext?: string;
  /** Agent 个性/策略内容（可选） */
  soulContent?: string;
}

/**
 * 认知决策结果：在 MaintainerDecision 基础上增加可解释字段
 */
export interface CognitiveDecision extends MaintainerDecision {
  /** 对当前问题的分析 */
  analysis: string;
  /** 考虑过的候选方案列表 */
  consideredOptions: string[];
  /** 最终选择该方案的原因 */
  reasoning: string;
  /** 决策置信度 */
  confidence: 'high' | 'medium' | 'low';
}
