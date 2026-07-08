import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { MergeRequest, ReviewFinding } from '../provider/types.js';
import { LlmClient } from '../../llm/client.js';
import { parsePatch, applyPatch } from './patch-applier.js';
import { buildFocusedContext } from './focused-context-builder.js';
import { CrossFilePlanner } from './cross-file-planner.js';
import type { IssueScope } from './issue-scope.js';

export interface MrFixAgentOptions {
  worktreeManager: WorktreeManager;
  llmClient: LlmClient;
}

export interface FixAttemptResult {
  success: boolean;
  reason: string;
  commitSha?: string;
}

export interface ExecuteFixOptions {
  scope?: IssueScope;
}

/**
 * MR 自动修复 Agent
 *
 * 对单个 finding 执行自动修复：
 * 准备 worktree → 聚焦上下文 → 生成 unified diff → 应用 patch → 校验 → commit push。
 */
export class MrFixAgent {
  constructor(private readonly options: MrFixAgentOptions) {}

  /**
   * 执行修复
   */
  async executeFix(
    finding: ReviewFinding,
    mr: MergeRequest,
    options?: ExecuteFixOptions
  ): Promise<FixAttemptResult> {
    console.log(`[MrFixAgent] 开始执行修复 ${finding.file}:${finding.line} (${finding.severity})`);

    try {
      console.log(`[MrFixAgent] 阶段=worktree 准备/更新 worktree`);
      await this.options.worktreeManager.ensureWorktree();
      console.log(`[MrFixAgent] 阶段=checkout 切换到 source branch: ${mr.sourceBranch}`);
      await this.options.worktreeManager.checkoutBranch(mr.sourceBranch);

      console.log(`[MrFixAgent] 阶段=prepare 准备运行环境`);
      await this.options.worktreeManager.prepareEnvironment();

      const scope = options?.scope ?? 'local';
      if (scope === 'cross-file') {
        return await this.executeCrossFileFix(finding, mr);
      }

      return await this.executeSingleFileFix(finding, mr);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[MrFixAgent] 自动修复异常: ${reason}`);
      return {
        success: false,
        reason,
      };
    }
  }

  private async executeSingleFileFix(
    finding: ReviewFinding,
    mr: MergeRequest
  ): Promise<FixAttemptResult> {
    console.log(`[MrFixAgent] 阶段=read 读取文件: ${finding.file}`);
    const originalContent = this.options.worktreeManager.readFile(finding.file);

    console.log(`[MrFixAgent] 阶段=generate 请求 LLM 生成修复 patch: ${finding.file}`);
    const patchText = await this.generatePatch(finding, originalContent);
    if (!patchText) {
      return {
        success: false,
        reason: 'LLM 未生成有效修复 patch',
      };
    }

    const newContent = this.applyPatchText(originalContent, patchText, finding.file);
    if (newContent === null) {
      return {
        success: false,
        reason: `无法应用 LLM 生成的 patch：${finding.file}`,
      };
    }

    console.log(`[MrFixAgent] 阶段=write 写入修复后的文件: ${finding.file}`);
    this.options.worktreeManager.writeFile(finding.file, newContent);

    return this.validateAndPush(finding, mr);
  }

  private async executeCrossFileFix(
    finding: ReviewFinding,
    mr: MergeRequest
  ): Promise<FixAttemptResult> {
    console.log(`[MrFixAgent] 阶段=plan 生成跨文件修改计划: ${finding.file}`);
    const originalContent = this.options.worktreeManager.readFile(finding.file);
    const focused = buildFocusedContext(originalContent, finding);
    const planner = new CrossFilePlanner({ llmClient: this.options.llmClient });
    const plan = await planner.plan(finding, focused);

    console.log(
      `[MrFixAgent] 跨文件计划: ${plan.reason}，涉及 ${plan.patches.length} 个文件`
    );

    for (const planned of plan.patches) {
      console.log(`[MrFixAgent] 阶段=generate 生成 patch: ${planned.filePath}`);
      const fileContent = this.options.worktreeManager.readFile(planned.filePath);
      const patchText = await this.generatePatchForPlannedFile(finding, planned.filePath, fileContent, planned.description);
      if (!patchText) {
        return {
          success: false,
          reason: `LLM 未生成 ${planned.filePath} 的有效 patch`,
        };
      }

      const newContent = this.applyPatchText(fileContent, patchText, planned.filePath);
      if (newContent === null) {
        return {
          success: false,
          reason: `无法应用 ${planned.filePath} 的 patch`,
        };
      }

      console.log(`[MrFixAgent] 阶段=write 写入修复后的文件: ${planned.filePath}`);
      this.options.worktreeManager.writeFile(planned.filePath, newContent);
    }

    return this.validateAndPush(finding, mr);
  }

  private applyPatchText(originalContent: string, patchText: string, filePath: string): string | null {
    const patches = parsePatch(patchText);
    if (patches.length === 0) {
      console.warn(`[MrFixAgent] 无法从 LLM 输出解析出 patch: ${filePath}`);
      return null;
    }

    // 如果 LLM 只返回一个文件 patch，直接应用
    const targetPatch = patches.find((p) => p.oldPath === filePath || p.newPath === filePath) ?? patches[0];
    const result = applyPatch(originalContent, targetPatch);
    if (!result.success) {
      console.warn(
        `[MrFixAgent] patch 应用失败: ${filePath}, hunk=${result.conflict?.hunkIndex}, line=${result.conflict?.expectedLine}, reason=${result.conflict?.reason}`
      );
      return null;
    }
    return result.content ?? null;
  }

  private async validateAndPush(
    finding: ReviewFinding,
    mr: MergeRequest
  ): Promise<FixAttemptResult> {
    console.log(`[MrFixAgent] 阶段=validate 运行 lint / typecheck 校验`);
    const validation = await this.options.worktreeManager.validate();
    console.log(`[MrFixAgent] 校验结果: lint=${validation.lint}, typecheck=${validation.typecheck}`);
    if (!validation.lint || !validation.typecheck) {
      const reasons: string[] = [];
      if (!validation.lint) {
        reasons.push(`lint=${validation.lint}${validation.lintReason ? ` (${validation.lintReason})` : ''}`);
      }
      if (!validation.typecheck) {
        reasons.push(`typecheck=${validation.typecheck}${validation.typecheckReason ? ` (${validation.typecheckReason})` : ''}`);
      }
      return {
        success: false,
        reason: `校验未通过：${reasons.join(', ')}`,
      };
    }

    const message = `[CodeKeeper] fix: ${finding.message}\n\n规则: ${finding.ruleId ?? 'N/A'}\n文件: ${finding.file}:${finding.line}`;
    console.log(`[MrFixAgent] 阶段=commit-push 提交并推送修复到分支: ${mr.sourceBranch}`);
    await this.options.worktreeManager.commitAndPush(mr.sourceBranch, message, {
      setUpstream: false,
    });

    return {
      success: true,
      reason: '修复已推送至 source branch',
    };
  }

  /**
   * 调用 LLM 为指定 finding 生成 unified diff 补丁
   */
  private async generatePatch(
    finding: ReviewFinding,
    fileContent: string
  ): Promise<string | null> {
    const prompt = `请为以下代码问题生成标准 unified diff 格式的修复补丁。

文件: ${finding.file}
问题行号: ${finding.line}
问题: ${finding.message}
严重程度: ${finding.severity}
建议: ${finding.suggestion}

文件完整内容：
\`\`\`
${fileContent}
\`\`\`

请只输出统一 diff 补丁（包含 diff --git、---、+++、@@ 行），不要输出任何解释或完整文件内容。
补丁应尽可能小，只修改与问题相关的行。
注意：hunk 中的行号必须对应上面给出的完整文件内容。`;

    const response = await this.options.llmClient.complete(prompt, undefined);
    return this.cleanPatchOutput(response);
  }

  private async generatePatchForPlannedFile(
    finding: ReviewFinding,
    filePath: string,
    fileContent: string,
    description: string
  ): Promise<string | null> {
    const prompt = `请为以下跨文件修改需求生成标准 unified diff 格式的补丁。

目标文件: ${filePath}
修改说明: ${description}

原始问题来自 ${finding.file}:${finding.line}：
问题: ${finding.message}
建议: ${finding.suggestion}

目标文件当前内容：
\`\`\`
${fileContent}
\`\`\`

请只输出统一 diff 补丁（包含 diff --git、---、+++、@@ 行），不要输出任何解释或完整文件内容。
补丁应尽可能小，只修改与说明相关的行。`;

    const response = await this.options.llmClient.complete(prompt, undefined);
    return this.cleanPatchOutput(response);
  }

  private cleanPatchOutput(rawResponse: string): string | null {
    const trimmed = rawResponse.trim();
    if (!trimmed) {
      return null;
    }

    // 如果 LLM 把 patch 包在 markdown 代码块里，去掉外层
    const codeBlockMatch = trimmed.match(/```(?:diff)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    return trimmed;
  }
}
