/**
 * 修复工具循环核心
 *
 * 维护消息历史，驱动 LLM 在 worktree 中主动使用工具完成修复。
 */

import type { LlmClient } from '../../llm/client.js';
import type { LlmMessage, ToolCall, ToolResult } from '../../llm/tool-types.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { ReviewFinding } from '../provider/types.js';
import type { MergeRequest } from '../provider/types.js';
import type { IMemoryClient } from '../memory/types.js';
import type { RecallPlanner } from '../memory/recall-planner.js';
import { FIX_TOOLS } from './tools/tool-definitions.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ToolExecutor } from './tools/tool-executor.js';
import type { FixAttemptResult } from './fix-result.js';
import { logMemorySnapshot } from '../utils/memory-snapshot.js';

export interface FixToolLoopOptions {
  llmClient: LlmClient;
  worktreeManager: WorktreeManager;
  finding: ReviewFinding;
  mr: MergeRequest;
  memoryClient?: IMemoryClient;
  recallPlanner?: RecallPlanner;
  /** 最大循环步数，默认 20 */
  maxSteps?: number;
  /** 额外系统提示 */
  extraSystemPrompt?: string;
}

export class FixToolLoop {
  private readonly llmClient: LlmClient;
  private readonly finding: ReviewFinding;
  private readonly mr: MergeRequest;
  private readonly maxSteps: number;
  private readonly extraSystemPrompt: string;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly messages: LlmMessage[] = [];

  private appliedFiles = new Set<string>();
  private deletedFiles = new Set<string>();
  private validationPassed = false;

  constructor(options: FixToolLoopOptions) {
    this.llmClient = options.llmClient;
    this.finding = options.finding;
    this.mr = options.mr;
    this.maxSteps = options.maxSteps ?? 20;
    this.extraSystemPrompt = options.extraSystemPrompt ?? '';
    this.registry = new ToolRegistry(FIX_TOOLS);
    this.executor = new ToolExecutor({
      worktreeManager: options.worktreeManager,
      memoryClient: options.memoryClient,
      recallPlanner: options.recallPlanner,
    });
  }

  /**
   * 运行工具循环，直到完成、失败或达到最大步数
   */
  async run(): Promise<FixAttemptResult> {
    this.messages.push({
      role: 'user',
      content: this.buildTaskPrompt(),
    });

    for (let step = 0; step < this.maxSteps; step++) {
      console.log(`[FixToolLoop] 第 ${step + 1}/${this.maxSteps} 步`);
      logMemorySnapshot(`FixToolLoop 第 ${step + 1} 步开始`);
      console.log(`[FixToolLoop] messages 数量=${this.messages.length}, 总字符=${this.messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : m.content.reduce((s, p) => s + (('text' in p && p.text) ? p.text.length : 0), 0)), 0)}`);

      const result = await this.llmClient.completeWithTools(
        this.messages,
        this.registry.list(),
        { system: this.buildSystemPrompt() }
      );

      console.log(
        `[FixToolLoop] LLM 停止原因=${result.stopReason}, toolCalls=${result.toolCalls.length}`
      );

      this.messages.push({
        role: 'assistant',
        content: [
          ...(result.content ? [{ type: 'text' as const, text: result.content }] : []),
          ...result.toolCalls.map((tc: ToolCall) => ({ type: 'tool_use' as const, ...tc })),
        ],
      });

      if (result.toolCalls.length === 0) {
        return {
          success: false,
          reason: `LLM 未调用任何工具即结束（stopReason=${result.stopReason}）`,
        };
      }

      const toolResults = await this.executeToolCalls(result.toolCalls);

      this.messages.push({
        role: 'user',
        content: toolResults.map((tr) => ({ type: 'tool_result' as const, ...tr })),
      });

      const finishCall = result.toolCalls.find((tc: ToolCall) => tc.name === 'finish');
      if (finishCall) {
        return this.handleFinish(finishCall);
      }
    }

    return {
      success: false,
      reason: `达到最大步数 ${this.maxSteps}，修复未收敛`,
    };
  }

  getAppliedFiles(): string[] {
    return Array.from(this.appliedFiles);
  }

  getDeletedFiles(): string[] {
    return Array.from(this.deletedFiles);
  }

  private buildSystemPrompt(): string {
    return [
      '你是 CodeKeeper Maintainer Agent，负责在隔离的 git worktree 中修复代码。',
      '',
      '工作原则：',
      '1. 所有修改必须在 worktree 内进行，不能影响主仓库。',
      '2. 你只能使用提供的工具操作 worktree；不能运行任意 shell 命令。',
      '3. run_script 只能调用 package.json 中白名单内的 npm scripts（lint、typecheck、build、test、compile:packages）。',
      '4. 修改前若不确定，先 read_file 查看文件内容；跨文件修改需分别读写相关文件。',
      '5. 你可以使用 apply_patch 应用 unified diff，也可以直接用 write_file 重写整个文件（仅限小文件）。',
      '6. 完成修改后，必须调用 validate 确认 lint 和 typecheck 通过。',
      '7. 若修复成功并通过验证，调用 finish({ success: true, reason: "..." })。',
      '8. 若无法修复、验证失败或需要 Reviewer 澄清，调用 finish({ success: false, reason: "..." })。',
      '9. 不能直接提交或推送代码，提交由框架在循环外统一处理。',
      this.extraSystemPrompt,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildTaskPrompt(): string {
    return [
      '请修复以下代码问题。',
      '',
      `文件: ${this.finding.file}`,
      `行号: ${this.finding.line}`,
      `问题: ${this.finding.message}`,
      `建议: ${this.finding.suggestion ?? '无'}`,
      `严重程度: ${this.finding.severity}`,
      '',
      `MR: ${this.mr.title}`,
      `源分支: ${this.mr.sourceBranch}`,
      `目标分支: ${this.mr.targetBranch}`,
      '',
      '请按工作原则使用工具完成修复。',
    ].join('\n');
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      if (!this.registry.has(toolCall.name)) {
        results.push({
          tool_use_id: toolCall.id,
          content: JSON.stringify({ success: false, error: `未知工具: ${toolCall.name}` }),
          is_error: true,
        });
        continue;
      }

      console.log(`[FixToolLoop] 执行工具: ${toolCall.name}, 参数: ${JSON.stringify(toolCall.input)}`);
      const result = await this.executor.execute(toolCall);
      console.log(`[FixToolLoop] 工具结果: ${result.content.slice(0, 500)}`);

      this.trackFileChange(toolCall, result);
      results.push(result);
    }
    return results;
  }

  private trackFileChange(toolCall: ToolCall, result: ToolResult): void {
    if (toolCall.name === 'write_file' || toolCall.name === 'apply_patch') {
      const relPath = String(toolCall.input.relPath ?? '');
      if (relPath) this.appliedFiles.add(relPath);
    }
    if (toolCall.name === 'delete_file') {
      const relPath = String(toolCall.input.relPath ?? '');
      if (relPath) this.deletedFiles.add(relPath);
    }
    if (toolCall.name === 'validate') {
      try {
        const parsed = JSON.parse(result.content) as { success?: boolean; data?: { lint?: boolean; typecheck?: boolean } };
        this.validationPassed =
          parsed.success === true && parsed.data?.lint === true && parsed.data?.typecheck === true;
      } catch {
        this.validationPassed = false;
      }
    }
  }

  private handleFinish(finishCall: ToolCall): FixAttemptResult {
    const success = finishCall.input.success === true;
    const reason = String(finishCall.input.reason ?? '');

    if (success && !this.validationPassed) {
      return {
        success: false,
        reason: `LLM 认为修复成功，但尚未通过 validate。${reason}`,
      };
    }

    return {
      success,
      reason: reason || (success ? '修复已完成并通过验证' : '修复未能完成'),
    };
  }
}
