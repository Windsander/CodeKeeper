import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { MergeRequest, ReviewFinding } from '../provider/types.js';
import { LlmClient } from '../../llm/client.js';

export interface MrFixAgentOptions {
  worktreeManager: WorktreeManager;
  llmClient: LlmClient;
}

export interface FixAttemptResult {
  success: boolean;
  reason: string;
  commitSha?: string;
}

/**
 * MR 自动修复 Agent
 *
 * 对单个 finding 执行自动修复：
 * 准备 worktree → 读取文件 → 调用 LLM 生成修复 → 写文件 → 校验 → commit push。
 */
export class MrFixAgent {
  constructor(private readonly options: MrFixAgentOptions) {}

  /**
   * 执行修复
   */
  async executeFix(finding: ReviewFinding, mr: MergeRequest): Promise<FixAttemptResult> {
    console.log(`[MrFixAgent] 开始执行修复 ${finding.file}:${finding.line} (${finding.severity})`);

    try {
      console.log(`[MrFixAgent] 准备/更新 worktree`);
      await this.options.worktreeManager.ensureWorktree();
      console.log(`[MrFixAgent] 切换到 source branch: ${mr.sourceBranch}`);
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);

      console.log(`[MrFixAgent] 读取文件: ${finding.file}`);
      const originalContent = this.options.worktreeManager.readFile(finding.file);

      console.log(`[MrFixAgent] 请求 LLM 生成修复: ${finding.file}`);
      const fixedContent = await this.generateFix(finding.file, originalContent, finding);
      if (!fixedContent) {
        return {
          success: false,
          reason: 'LLM 未生成有效修复代码',
        };
      }

      console.log(`[MrFixAgent] 写入修复后的文件: ${finding.file}`);
      this.options.worktreeManager.writeFile(finding.file, fixedContent);

      console.log(`[MrFixAgent] 运行 lint / typecheck 校验`);
      const validation = await this.options.worktreeManager.validate();
      console.log(`[MrFixAgent] 校验结果: lint=${validation.lint}, typecheck=${validation.typecheck}`);
      if (!validation.lint || !validation.typecheck) {
        return {
          success: false,
          reason: `校验未通过：lint=${validation.lint}, typecheck=${validation.typecheck}`,
        };
      }

      const message = `[CodeKeeper] fix: ${finding.message}\n\n规则: ${finding.ruleId ?? 'N/A'}\n文件: ${finding.file}:${finding.line}`;
      console.log(`[MrFixAgent] 提交并推送修复到分支: ${mr.sourceBranch}`);
      await this.options.worktreeManager.commitAndPush(mr.sourceBranch, message, {
        setUpstream: false,
      });

      return {
        success: true,
        reason: '修复已推送至 source branch',
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MrFixAgent] 自动修复异常: ${reason}`);
      return {
        success: false,
        reason,
      };
    }
  }

  /**
   * 调用 LLM 为指定 finding 生成修复代码
   */
  private async generateFix(
    filePath: string,
    originalContent: string,
    finding: ReviewFinding
  ): Promise<string | null> {
    const prompt = `请为以下代码问题生成修复后的代码。

文件: ${filePath}
问题: ${finding.message}
严重程度: ${finding.severity}
建议: ${finding.suggestion}

原始代码:
\`\`\`
${originalContent}
\`\`\`

请只输出修复后的完整文件内容，不要包含任何解释或 markdown 代码块标记。`;

    const response = await this.options.llmClient.complete(prompt, undefined);
    return this.cleanFixOutput(response);
  }

  private cleanFixOutput(rawResponse: string): string | null {
    const trimmed = rawResponse.trim();
    if (!trimmed) {
      return null;
    }

    const codeBlockMatch = trimmed.match(/```(?:\w+)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    return trimmed;
  }
}
