import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { ClassicReviewer } from '../review/reviewer.js';
import type { MergeRequest, ReviewFinding } from '../provider/types.js';
import { FixDecisionEngine } from './fix-decision-engine.js';

export interface MrFixAgentOptions {
  worktreeManager: WorktreeManager;
  reviewer: ClassicReviewer;
  decisionEngine?: FixDecisionEngine;
}

export interface FixAttemptResult {
  success: boolean;
  action: 'fix' | 'skip' | 'defer';
  reason: string;
  commitSha?: string;
}

/**
 * MR 自动修复执行器
 *
 * 对单个 finding 做修复决策，并在 MR source branch 上直接提交修复。
 */
export class MrFixAgent {
  private readonly decisionEngine: FixDecisionEngine;

  constructor(private readonly options: MrFixAgentOptions) {
    this.decisionEngine = options.decisionEngine ?? new FixDecisionEngine();
  }

  /**
   * 处理单个 finding
   *
   * 流程：决策 → checkout source branch → 生成 fix → 写文件 → 校验 → commit push
   */
  async processFinding(
    finding: ReviewFinding,
    mr: MergeRequest
  ): Promise<FixAttemptResult> {
    const decision = this.decisionEngine.decide(finding);

    if (decision.action !== 'fix') {
      return {
        success: false,
        action: decision.action,
        reason: decision.reason,
      };
    }

    try {
      await this.options.worktreeManager.ensureWorktree();
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);

      const originalContent = this.options.worktreeManager.readFile(finding.file);
      const fixedContent = await this.options.reviewer.generateFix(
        finding.file,
        originalContent,
        finding
      );
      if (!fixedContent) {
        return {
          success: false,
          action: 'skip',
          reason: 'LLM 未生成有效修复代码',
        };
      }

      this.options.worktreeManager.writeFile(finding.file, fixedContent);

      const validation = await this.options.worktreeManager.validate();
      if (!validation.lint || !validation.typecheck) {
        return {
          success: false,
          action: 'defer',
          reason: `校验未通过：lint=${validation.lint}, typecheck=${validation.typecheck}`,
        };
      }

      const message = `[CodeKeeper] fix: ${finding.message}\n\n规则: ${finding.ruleId ?? 'N/A'}\n文件: ${finding.file}:${finding.line}`;
      await this.options.worktreeManager.commitAndPush(mr.sourceBranch, message, {
        setUpstream: false,
      });

      return {
        success: true,
        action: 'fix',
        reason: '修复已推送至 source branch',
      };
    } catch (err) {
      return {
        success: false,
        action: 'defer',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
