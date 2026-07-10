/**
 * 修复结果类型
 *
 * 原 mr-fix-agent.ts 中的共享类型已迁移至此，供工具循环与 Actor 共享。
 */

export interface FixAttemptResult {
  /** 是否成功 */
  success: boolean;
  /** 说明 */
  reason: string;
}

export interface BatchFixResult {
  /** 整体是否成功 */
  success: boolean;
  /** 说明 */
  reason: string;
  /** 成功应用的文件列表 */
  appliedFiles: string[];
  /** 应用失败的文件列表 */
  failedFiles: string[];
}

export interface EnvironmentPrepContext {
  /** typecheck 原始输出 */
  validateOutput: string;
  /** package.json 中可用的 scripts 名称列表 */
  availableScripts: string[];
}

export interface EnvironmentPrepDecision {
  /** 要执行的 npm script，为空表示不需要或无法处理 */
  script?: string;
  /** 决策原因 */
  reason: string;
}
