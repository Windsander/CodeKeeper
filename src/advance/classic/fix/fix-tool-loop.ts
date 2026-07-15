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
import { extractJsonText } from '../utils/json-extraction.js';
import type { ValidationStrategy, ValidationResult } from './validation-strategy.js';
import { ErrorDeltaValidationStrategy } from './validation-strategy.js';
import { defaultPromptLoader, type PromptLoader } from '../../llm/prompts/loader.js';

export interface FixToolLoopOptions {
  llmClient: LlmClient;
  worktreeManager: WorktreeManager;
  finding: ReviewFinding;
  mr: MergeRequest;
  memoryClient?: IMemoryClient;
  recallPlanner?: RecallPlanner;
  /** 最大循环步数，默认 20 */
  maxSteps?: number;
  /** 单轮 LLM 回复的最大 token 数（输出约束，非整个会话），默认 8192 */
  maxTokens?: number;
  /** 输出被长度截断时的最大连续重试次数，默认 3 */
  maxTruncationRetries?: number;
  /** LLM 未调用任何工具时的最大连续重试次数，默认 2 */
  maxNoToolCallRetries?: number;
  /** finish 成功但未实际修改文件时的最大连续重试次数，默认 2 */
  maxUnchangedFinishRetries?: number;
  /** 额外系统提示 */
  extraSystemPrompt?: string;
  /** 验证策略，默认 WorkspaceValidationStrategy */
  validationStrategy?: ValidationStrategy;
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

/** 判断 stopReason 是否表示输出被长度截断 */
function isTruncatedStopReason(stopReason: string): boolean {
  return stopReason === 'length' || stopReason === 'max_tokens';
}

export class FixToolLoop {
  private readonly llmClient: LlmClient;
  private readonly worktreeManager: WorktreeManager;
  private readonly finding: ReviewFinding;
  private readonly mr: MergeRequest;
  private readonly maxSteps: number;
  private readonly maxTokens: number;
  private readonly maxTruncationRetries: number;
  private readonly maxNoToolCallRetries: number;
  private readonly maxUnchangedFinishRetries: number;
  private readonly extraSystemPrompt: string;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly validationStrategy: ValidationStrategy;
  private readonly promptLoader: PromptLoader;
  private readonly messages: LlmMessage[] = [];

  private appliedFiles = new Set<string>();
  private deletedFiles = new Set<string>();
  private readFilesThisRun = new Set<string>();
  private stepsWithoutProgress = 0;
  private budgetReminderSent = false;
  private baselineResult?: ValidationResult;
  private lastValidationResult?: ValidationResult;
  private fallbackId = 0;
  private truncationRetries = 0;
  private noToolCallRetries = 0;
  private unchangedFinishRetries = 0;

  constructor(options: FixToolLoopOptions) {
    this.llmClient = options.llmClient;
    this.worktreeManager = options.worktreeManager;
    this.finding = options.finding;
    this.mr = options.mr;
    this.maxSteps = options.maxSteps ?? 20;
    this.maxTokens = options.maxTokens ?? 8192;
    this.maxTruncationRetries = options.maxTruncationRetries ?? 3;
    this.maxNoToolCallRetries = options.maxNoToolCallRetries ?? 2;
    this.maxUnchangedFinishRetries = options.maxUnchangedFinishRetries ?? 2;
    this.extraSystemPrompt = options.extraSystemPrompt ?? '';
    this.promptLoader = options.promptLoader ?? defaultPromptLoader;
    this.registry = new ToolRegistry(FIX_TOOLS);
    this.executor = new ToolExecutor({
      worktreeManager: options.worktreeManager,
      memoryClient: options.memoryClient,
      recallPlanner: options.recallPlanner,
    });
    this.validationStrategy = options.validationStrategy ?? new ErrorDeltaValidationStrategy();
  }

  /**
   * 运行工具循环，直到完成、失败或达到最大步数
   */
  async run(): Promise<FixAttemptResult> {
    console.log(
      `[FixToolLoop] 开始修复 ${this.finding.file}:${this.finding.line}，问题: ${this.finding.message}`
    );
    this.messages.push({
      role: 'user',
      content: this.buildTaskPrompt(),
    });

    if (this.validationStrategy.needsBaseline) {
      this.baselineResult = await this.validationStrategy.evaluate({
        worktreeManager: this.worktreeManager,
        appliedFiles: [],
        deletedFiles: [],
      });
    }

    for (let step = 0; step < this.maxSteps; step++) {
      console.log(`[FixToolLoop] 第 ${step + 1}/${this.maxSteps} 步`);
      logMemorySnapshot(`FixToolLoop 第 ${step + 1} 步开始`);
      console.log(`[FixToolLoop] messages 数量=${this.messages.length}, 总字符=${this.estimateMessagesChars()}`);

      if (step === this.maxSteps - 4 && !this.budgetReminderSent) {
        this.budgetReminderSent = true;
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-budget-reminder'),
        });
      }

      const result = await this.llmClient.completeWithTools(
        this.messages,
        this.registry.list(),
        { system: this.buildSystemPrompt(), toolChoice: { type: 'any' }, maxTokens: this.maxTokens }
      );

      console.log(
        `[FixToolLoop] LLM 停止原因=${result.stopReason}, toolCalls=${result.toolCalls.length}`
      );

      let toolCalls = result.toolCalls;
      if (toolCalls.length === 0 && result.content.trim()) {
        const parsed = this.tryParseToolCallsFromContent(result.content);
        if (parsed.length > 0) {
          console.log(`[FixToolLoop] 从 content 兜底解析出 ${parsed.length} 个工具调用`);
          toolCalls = parsed;
        }
      }

      // 输出被长度截断：回复中的工具调用 JSON 可能残缺，不可信，全部丢弃；
      // 截断内容不入历史，直接提示模型用更小的块重试（像正常 Agent harness 一样续接）
      if (isTruncatedStopReason(result.stopReason)) {
        this.truncationRetries++;
        if (this.truncationRetries > this.maxTruncationRetries) {
          return {
            success: false,
            reason: `LLM 输出连续 ${this.truncationRetries} 次被长度截断（stopReason=${result.stopReason}），修复未收敛`,
          };
        }
        console.log(
          `[FixToolLoop] 输出被长度截断，丢弃 ${toolCalls.length} 个可能残缺的工具调用并请求重试（${this.truncationRetries}/${this.maxTruncationRetries}）`
        );
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-truncation-reminder'),
        });
        continue;
      }
      this.truncationRetries = 0;

      this.messages.push({
        role: 'assistant',
        content: [
          ...(result.content ? [{ type: 'text' as const, text: result.content }] : []),
          ...toolCalls.map((tc: ToolCall) => ({ type: 'tool_use' as const, ...tc })),
        ],
      });

      if (toolCalls.length === 0) {
        this.noToolCallRetries++;
        if (this.noToolCallRetries > this.maxNoToolCallRetries) {
          const preview = result.content.trim().slice(0, 300);
          return {
            success: false,
            reason:
              `LLM 连续 ${this.noToolCallRetries} 轮未调用任何工具（stopReason=${result.stopReason}）` +
              (preview ? `，最后回复：${preview}` : ''),
          };
        }
        console.log(
          `[FixToolLoop] LLM 未调用工具（stopReason=${result.stopReason}），提示必须调用工具并重试（${this.noToolCallRetries}/${this.maxNoToolCallRetries}）`
        );
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-no-tool-reminder'),
        });
        continue;
      }
      this.noToolCallRetries = 0;

      const prevAppliedCount = this.appliedFiles.size;
      const prevDeletedCount = this.deletedFiles.size;
      const prevReadCount = this.readFilesThisRun.size;

      const toolResults = await this.executeToolCalls(toolCalls);

      const hasFileChange =
        this.appliedFiles.size > prevAppliedCount || this.deletedFiles.size > prevDeletedCount;
      const hasNewRead = this.readFilesThisRun.size > prevReadCount;
      if (hasFileChange || hasNewRead) {
        this.stepsWithoutProgress = 0;
      } else {
        this.stepsWithoutProgress++;
      }

      // 如果本轮包含 validate 工具，用策略评估当前验证状态
      const validateCall = toolCalls.find((tc) => tc.name === 'validate');
      if (validateCall) {
        const validateResult = toolResults.find((tr) => tr.tool_use_id === validateCall.id);
        if (validateResult) {
          const raw = this.parseValidateResult(validateResult);
          this.lastValidationResult = await this.validationStrategy.evaluate({
            worktreeManager: this.worktreeManager,
            appliedFiles: Array.from(this.appliedFiles),
            deletedFiles: Array.from(this.deletedFiles),
            rawResult: raw,
            baseline: this.baselineResult,
          });
        }
      }

      this.messages.push({
        role: 'user',
        content: toolResults.map((tr) => ({ type: 'tool_result' as const, ...tr })),
      });

      if (this.stepsWithoutProgress === 3) {
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-stale-reminder'),
        });
      }

      const finishCall = toolCalls.find((tc: ToolCall) => tc.name === 'finish');
      if (finishCall) {
        const finishResult = this.handleFinish(finishCall);
        // LLM 可能 hallucinate：声称成功但实际没有修改任何文件。给它一次（或多次）重新实际修改的机会。
        if (
          !finishResult.success &&
          this.unchangedFinishRetries < this.maxUnchangedFinishRetries &&
          finishResult.reason.includes('未实际修改或删除任何文件')
        ) {
          this.unchangedFinishRetries++;
          console.log(
            `[FixToolLoop] finish 成功但未产生文件变更，要求 LLM 重新实际修改（${this.unchangedFinishRetries}/${this.maxUnchangedFinishRetries}）`
          );
          this.messages.push({
            role: 'user',
            content: this.promptLoader.load('fix-tool-loop-unchanged-finish-reminder'),
          });
          continue;
        }
        return finishResult;
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

  /**
   * 估算消息历史的总字符数，用于诊断上下文膨胀。
   * 需覆盖所有部分类型：text、tool_result.content、tool_use.input。
   */
  private estimateMessagesChars(): number {
    return this.messages.reduce((sum, m) => {
      if (typeof m.content === 'string') {
        return sum + m.content.length;
      }
      return (
        sum +
        m.content.reduce((s, part) => {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return s + p.text.length;
          if (typeof p.content === 'string') return s + p.content.length;
          if (p.input !== undefined) {
            try {
              return s + JSON.stringify(p.input).length;
            } catch {
              return s;
            }
          }
          return s;
        }, 0)
      );
    }, 0);
  }

  getDeletedFiles(): string[] {
    return Array.from(this.deletedFiles);
  }

  private buildSystemPrompt(): string {
    return this.promptLoader
      .load('fix-tool-loop-system', {
        findingFile: this.finding.file,
        extraSystemPrompt: this.extraSystemPrompt,
      })
      .trim();
  }

  private buildTaskPrompt(): string {
    const suggestionHint = this.finding.suggestion
      ? 'Reviewer 已给出参考建议，但请不要盲目照搬；请先结合代码理解问题根因，再选择最合适的修复方案。如果建议需要调整（例如符号未导入/未导出、或存在更优雅的改法），可同步修改相关文件。'
      : '';

    return this.promptLoader.load('fix-tool-loop-task', {
      findingFile: this.finding.file,
      findingLine: String(this.finding.line),
      findingMessage: this.finding.message,
      findingSuggestion: this.finding.suggestion ?? '无',
      findingSeverity: this.finding.severity,
      mrTitle: this.mr.title,
      mrSourceBranch: this.mr.sourceBranch,
      mrTargetBranch: this.mr.targetBranch,
      suggestionHint,
    });
  }

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      if (toolCall.name === 'read_file') {
        const relPath = String(toolCall.input.relPath ?? '');
        if (relPath) this.readFilesThisRun.add(relPath);
      }
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
    try {
      const parsed = JSON.parse(result.content) as { success?: boolean; data?: { unchanged?: boolean } };
      if (!parsed.success) {
        return;
      }
      if (toolCall.name === 'write_file' || toolCall.name === 'apply_patch') {
        if (parsed.data?.unchanged === true) {
          return;
        }
        const relPath = String(toolCall.input.relPath ?? '');
        if (relPath) this.appliedFiles.add(relPath);
      }
      if (toolCall.name === 'delete_file') {
        const relPath = String(toolCall.input.relPath ?? '');
        if (relPath) this.deletedFiles.add(relPath);
      }
    } catch {
      // 解析失败时保守处理，不记录文件变更
    }
  }

  private tryParseToolCallsFromContent(content: string): ToolCall[] {
    try {
      const extracted = extractJsonText(content);
      const parsed = JSON.parse(extracted) as unknown;
      const candidates: Array<{ name?: unknown; input?: unknown }> = [];
      if (Array.isArray(parsed)) {
        candidates.push(...parsed);
      } else if (parsed && typeof parsed === 'object') {
        candidates.push(parsed as Record<string, unknown>);
      }

      const calls: ToolCall[] = [];
      for (const c of candidates) {
        const name = typeof c.name === 'string' ? c.name : '';
        if (!this.registry.has(name)) continue;
        const input = c.input && typeof c.input === 'object' && !Array.isArray(c.input)
          ? (c.input as Record<string, unknown>)
          : (c as Record<string, unknown>);
        calls.push({
          id: `fallback-${this.fallbackId++}`,
          name,
          input,
        });
      }
      return calls;
    } catch {
      return [];
    }
  }

  private parseValidateResult(
    result: ToolResult
  ): { lint: boolean; typecheck: boolean; lintReason?: string; typecheckReason?: string } {
    try {
      const parsed = JSON.parse(result.content) as {
        success?: boolean;
        data?: {
          lint?: boolean;
          typecheck?: boolean;
          lintReason?: string;
          typecheckReason?: string;
        };
      };
      return {
        lint: parsed.data?.lint ?? false,
        typecheck: parsed.data?.typecheck ?? false,
        lintReason: parsed.data?.lintReason,
        typecheckReason: parsed.data?.typecheckReason,
      };
    } catch {
      return { lint: false, typecheck: false };
    }
  }

  private handleFinish(finishCall: ToolCall): FixAttemptResult {
    const success = finishCall.input.success === true;
    const reason = String(finishCall.input.reason ?? '');

    if (success && !this.lastValidationResult?.passed) {
      return {
        success: false,
        reason: `LLM 认为修复成功，但尚未通过验证策略：${this.lastValidationResult?.reason ?? '未调用 validate'}`,
      };
    }

    if (success && this.appliedFiles.size === 0 && this.deletedFiles.size === 0) {
      return {
        success: false,
        reason: 'LLM 认为修复成功，但未实际修改或删除任何文件',
      };
    }

    return {
      success,
      reason: reason || (success ? '修复已完成并通过验证' : '修复未能完成'),
    };
  }
}
