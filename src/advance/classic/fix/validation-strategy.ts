import type { WorktreeManager } from '../worktree/worktree-manager.js';

/**
 * 验证策略评估结果
 */
export interface ValidationResult {
  /** 是否通过验证策略 */
  passed: boolean;
  /** 人类可读的原因 */
  reason: string;
  /** 附加细节 */
  details?: unknown;
}

/**
 * 验证策略上下文
 */
export interface ValidationContext {
  worktreeManager: WorktreeManager;
  /** 本轮已修改的文件路径 */
  appliedFiles: string[];
  /** 本轮已删除的文件路径 */
  deletedFiles: string[];
  /** validate 工具返回的原始结果 */
  rawResult?: { lint: boolean; typecheck: boolean; lintReason?: string; typecheckReason?: string };
  /** 修复前基线，仅部分策略需要 */
  baseline?: ValidationResult;
}

/**
 * 可插拔的验证策略接口
 */
export interface ValidationStrategy {
  /** 是否需要 FixToolLoop 在循环开始前采集基线 */
  needsBaseline?: boolean;
  /** 根据上下文评估当前修复是否通过 */
  evaluate(ctx: ValidationContext): Promise<ValidationResult>;
}

/**
 * workspace 级验证策略：要求 lint 和 typecheck 全部通过。
 *
 * 保持原有 FixToolLoop 行为，适用于 workspace 没有预存错误的情况。
 */
export class WorkspaceValidationStrategy implements ValidationStrategy {
  async evaluate(ctx: ValidationContext): Promise<ValidationResult> {
    const raw = ctx.rawResult ?? (await ctx.worktreeManager.validate());
    const passed = raw.lint === true && raw.typecheck === true;
    return {
      passed,
      reason: passed
        ? 'lint 和 typecheck 均通过'
        : `lint=${raw.lint}, typecheck=${raw.typecheck}`,
      details: raw,
    };
  }
}

/**
 * 错误增量验证策略：比较修复前后 lint/typecheck 错误数。
 *
 * 只要错误数没有增加，就认为本次修复没有引入新问题；适用于 workspace
 * 存在与本次修复无关的预存错误时。
 */
export class ErrorDeltaValidationStrategy implements ValidationStrategy {
  needsBaseline = true;

  async evaluate(ctx: ValidationContext): Promise<ValidationResult> {
    const currentRaw = ctx.rawResult ?? (await ctx.worktreeManager.validate());
    const currentLintErrors = this.countErrors(currentRaw.lintReason ?? '');
    const currentTypeErrors = this.countErrors(currentRaw.typecheckReason ?? '');

    const baseline = ctx.baseline;
    if (!baseline) {
      // 首次调用用于建立基线，不比较增量
      return {
        passed: true,
        reason: `已建立修复前基线（lint 错误 ${currentLintErrors}，typecheck 错误 ${currentTypeErrors}）`,
        details: {
          lintErrors: currentLintErrors,
          typeErrors: currentTypeErrors,
          raw: currentRaw,
        },
      };
    }

    const baselineDetails = baseline.details as
      | { lintErrors?: number; typeErrors?: number }
      | undefined;

    const baselineLintErrors = baselineDetails?.lintErrors ?? 0;
    const baselineTypeErrors = baselineDetails?.typeErrors ?? 0;

    const lintDelta = currentLintErrors - baselineLintErrors;
    const typeDelta = currentTypeErrors - baselineTypeErrors;

    // 只要 lint/typecheck 错误没有增加，就认为本次修复没有引入新问题
    const passed = lintDelta <= 0 && typeDelta <= 0;
    return {
      passed,
      reason: passed
        ? `修复后未引入新错误（lint 变化 ${lintDelta}，typecheck 变化 ${typeDelta}）`
        : `修复后引入新错误（lint 变化 ${lintDelta}，typecheck 变化 ${typeDelta}）`,
      details: {
        baselineLintErrors,
        currentLintErrors,
        baselineTypeErrors,
        currentTypeErrors,
        raw: currentRaw,
      },
    };
  }

  private countErrors(output: string): number {
    if (!output) return 0;
    // 简单统计 lint/typecheck 输出中的 error 标记
    const matches = output.match(/error/gi);
    return matches ? matches.length : 0;
  }
}
