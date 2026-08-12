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
  /** 连续无实际进展（未修改/删除文件、未读取新文件窗口）的最大步数，默认 5 */
  maxStepsWithoutProgress?: number;
  /** 触发无进展提醒的步数阈值，默认 maxStepsWithoutProgress - 2 */
  staleReminderStep?: number;
  /** 额外系统提示 */
  extraSystemPrompt?: string;
  /** 连续未产生文件变更的最大步数，默认 8；新读取窗口不会无限延长该上限 */
  maxReadOnlySteps?: number;
  /** 触发只读探索提醒的步数阈值，默认 maxReadOnlySteps - 2 */
  readOnlyReminderStep?: number;
  /**
   * 只读熔断前的「带诊断谢幕」行动机会步数，默认 3。
   * 熔断时先把 already-fixed 回查结论注入上下文，再给 LLM 最后一轮
   * 修改或明确 finish 的机会，避免无诊断机械暴毙。
   */
  finalActingSteps?: number;
  /** 验证策略，默认 WorkspaceValidationStrategy */
  validationStrategy?: ValidationStrategy;
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
  /** 连续无进展时对当前完整文件做最终 already-fixed 回查 */
  recheckAlreadyFixed?: () => Promise<{
    alreadyFixed: boolean;
    reason: string;
    evidence?: string;
  }>;
}

/** 判断 stopReason 是否表示输出被长度截断 */
function isTruncatedStopReason(stopReason: string): boolean {
  return stopReason === 'length' || stopReason === 'max_tokens';
}

/** 兼容旧模型：识别“无需改动/已经修复”的自然语言 finish 原因。 */
export function looksLikeAlreadyFixedClaim(reason: string): boolean {
  return /already\s+(?:been\s+)?(?:fixed|resolved)|no\s+(?:additional\s+)?(?:code\s+)?change|无需(?:额外|再次|重复)?修改|无需再改|已(?:经)?修复|问题(?:已)?不存在|当前代码.{0,20}(?:满足|已包含|已覆盖)/i.test(
    reason
  );
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
  private readonly maxStepsWithoutProgress: number;
  private readonly staleReminderStep: number;
  private readonly extraSystemPrompt: string;
  private readonly maxReadOnlySteps: number;
  private readonly readOnlyReminderStep: number;
  private readonly finalActingSteps: number;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly validationStrategy: ValidationStrategy;
  private readonly promptLoader: PromptLoader;
  private readonly recheckAlreadyFixed?: FixToolLoopOptions['recheckAlreadyFixed'];
  private readonly messages: LlmMessage[] = [];

  private appliedFiles = new Set<string>();
  private deletedFiles = new Set<string>();
  private readFilesThisRun = new Set<string>();
  private stepsWithoutProgress = 0;
  private stepsWithoutFileChange = 0;
  private budgetReminderSent = false;
  private readOnlyReminderSent = false;
  private baselineResult?: ValidationResult;
  private lastValidationResult?: ValidationResult;
  private fallbackId = 0;
  private truncationRetries = 0;
  private noToolCallRetries = 0;
  private unchangedFinishRetries = 0;
  private alreadyFixedRecheckAttempted = false;
  private finalActingRoundUsed = false;
  /** 最近一次 already-fixed 回查的原始结论，用于谢幕消息与失败原因诊断 */
  private lastRecheckVerdict: { alreadyFixed: boolean; reason: string; evidence?: string } | null =
    null;

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
    this.maxStepsWithoutProgress = options.maxStepsWithoutProgress ?? 5;
    this.staleReminderStep =
      options.staleReminderStep ?? Math.max(1, this.maxStepsWithoutProgress - 2);
    this.extraSystemPrompt = options.extraSystemPrompt ?? '';
    this.maxReadOnlySteps =
      options.maxReadOnlySteps ?? Math.max(8, this.maxStepsWithoutProgress + 3);
    this.readOnlyReminderStep =
      options.readOnlyReminderStep ?? Math.max(1, this.maxReadOnlySteps - 2);
    this.finalActingSteps = Math.max(1, options.finalActingSteps ?? 3);
    this.promptLoader = options.promptLoader ?? defaultPromptLoader;
    this.recheckAlreadyFixed = options.recheckAlreadyFixed;
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
      console.log(
        `[FixToolLoop] messages 数量=${this.messages.length}, 总字符=${this.estimateMessagesChars()}`
      );

      if (step === this.maxSteps - 4 && !this.budgetReminderSent) {
        this.budgetReminderSent = true;
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-budget-reminder'),
        });
      }

      const result = await this.llmClient.completeWithTools(this.messages, this.registry.list(), {
        system: this.buildSystemPrompt(),
        toolChoice: { type: 'any' },
        maxTokens: this.maxTokens,
      });

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
      if (hasFileChange) {
        this.stepsWithoutFileChange = 0;
      } else {
        this.stepsWithoutFileChange++;
      }
      if (hasFileChange || hasNewRead) {
        this.stepsWithoutProgress = 0;
      } else {
        this.stepsWithoutProgress++;
      }

      // 如果本轮包含 validate 工具，用策略评估当前验证状态
      const validateCall = toolCalls.find(tc => tc.name === 'validate');
      if (validateCall) {
        const validateResult = toolResults.find(tr => tr.tool_use_id === validateCall.id);
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
        content: toolResults.map(tr => ({ type: 'tool_result' as const, ...tr })),
      });

      if (this.stepsWithoutProgress === this.staleReminderStep) {
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-stale-reminder'),
        });
      }

      if (this.stepsWithoutProgress >= this.maxStepsWithoutProgress) {
        const rechecked = await this.tryRecheckAlreadyFixed();
        if (rechecked) return rechecked;
        return {
          success: false,
          reason: this.promptLoader.load('fix-tool-loop-stale-failure-reason', {
            steps: String(this.stepsWithoutProgress),
          }),
        };
      }

      if (this.stepsWithoutFileChange === this.readOnlyReminderStep && !this.readOnlyReminderSent) {
        this.readOnlyReminderSent = true;
        this.messages.push({
          role: 'user',
          content: this.promptLoader.load('fix-tool-loop-read-only-reminder'),
        });
      }

      if (this.stepsWithoutFileChange >= this.maxReadOnlySteps) {
        const rechecked = await this.tryRecheckAlreadyFixed();
        if (rechecked) return rechecked;
        if (!this.finalActingRoundUsed) {
          // 带诊断谢幕：把 already-fixed 回查结论回灌给 LLM，
          // 给最后一轮「直接修改或明确 finish 并说明理由」的机会，避免无诊断机械暴毙。
          this.finalActingRoundUsed = true;
          this.messages.push({
            role: 'user',
            content: this.promptLoader.load('fix-tool-loop-final-acting-round', {
              steps: String(this.finalActingSteps),
              verdictReason: this.lastRecheckVerdict?.reason ?? '框架无法确认问题是否已消失',
              verdictEvidence: this.lastRecheckVerdict?.evidence ?? '无',
            }),
          });
          this.stepsWithoutFileChange = Math.max(0, this.maxReadOnlySteps - this.finalActingSteps);
          continue;
        }
        return {
          success: false,
          reason: this.promptLoader.load('fix-tool-loop-read-only-failure-reason', {
            steps: String(this.stepsWithoutFileChange),
            verdictReason: this.lastRecheckVerdict?.reason ?? '未执行回查',
            verdictEvidence: this.lastRecheckVerdict?.evidence ?? '无',
          }),
        };
      }

      const finishCall = toolCalls.find((tc: ToolCall) => tc.name === 'finish');
      if (finishCall) {
        const finishResult = await this.handleFinish(finishCall);
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

    const rechecked = await this.tryRecheckAlreadyFixed();
    if (rechecked) return rechecked;
    return {
      success: false,
      reason: `达到最大步数 ${this.maxSteps}，修复未收敛`,
    };
  }

  private async tryRecheckAlreadyFixed(): Promise<FixAttemptResult | null> {
    if (!this.recheckAlreadyFixed || this.alreadyFixedRecheckAttempted) return null;
    this.alreadyFixedRecheckAttempted = true;
    try {
      const result = await this.recheckAlreadyFixed();
      this.lastRecheckVerdict = result;
      if (!result.alreadyFixed) return null;
      return {
        success: true,
        alreadyFixed: true,
        reason: result.reason || '当前代码中已不存在该问题',
        evidence: result.evidence,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[FixToolLoop] already-fixed 回查失败: ${message}`);
      return null;
    }
  }

  getAppliedFiles(): string[] {
    return Array.from(this.appliedFiles);
  }

  /**
   * 本轮 run() 是否动用了「最后一轮行动机会」（只读熔断前的 final acting round）。
   * 供外部过程指标（readOnlyFinalActingRounds）使用。
   */
  wasFinalActingRoundUsed(): boolean {
    return this.finalActingRoundUsed;
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

  /**
   * 生成 read_file 调用的唯一进度 key。
   *
   * 同一文件的不同 startLine/endLine 或 targetLine/windowLines 窗口应视为不同读取，
   * 避免大文件滑动窗口读取被误判为重复读取。
   */
  private buildReadFileKey(relPath: string, input: Record<string, unknown>): string {
    const startLine = Number(input.startLine ?? 0);
    const endLine = Number(input.endLine ?? 0);
    const targetLine = Number(input.targetLine ?? 0);
    const windowLines = Number(input.windowLines ?? 0);
    if (targetLine > 0) {
      return `${relPath}:target=${targetLine},window=${windowLines || 80}`;
    }
    if (startLine > 0 && endLine > 0) {
      return `${relPath}:${startLine}-${endLine}`;
    }
    return `${relPath}:full`;
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
        if (relPath) {
          const readKey = this.buildReadFileKey(relPath, toolCall.input);
          this.readFilesThisRun.add(readKey);
        }
      }
      if (!this.registry.has(toolCall.name)) {
        results.push({
          tool_use_id: toolCall.id,
          content: JSON.stringify({ success: false, error: `未知工具: ${toolCall.name}` }),
          is_error: true,
        });
        continue;
      }

      console.log(
        `[FixToolLoop] 执行工具: ${toolCall.name}, 参数: ${JSON.stringify(toolCall.input)}`
      );
      const result = await this.executor.execute(toolCall);
      console.log(`[FixToolLoop] 工具结果: ${result.content.slice(0, 500)}`);

      this.trackFileChange(toolCall, result);
      results.push(result);
    }
    return results;
  }

  private trackFileChange(toolCall: ToolCall, result: ToolResult): void {
    try {
      const parsed = JSON.parse(result.content) as {
        success?: boolean;
        data?: { unchanged?: boolean };
      };
      if (!parsed.success) {
        return;
      }
      if (toolCall.name === 'write_file') {
        if (parsed.data?.unchanged === true) {
          return;
        }
        const relPath = String(toolCall.input.relPath ?? '');
        if (relPath) this.appliedFiles.add(relPath);
      }
      if (toolCall.name === 'apply_patch') {
        if (parsed.data?.unchanged === true) {
          return;
        }
        const patchText = String(toolCall.input.patchText ?? '');
        for (const relPath of this.extractPatchFilePaths(patchText)) {
          if (relPath) this.appliedFiles.add(relPath);
        }
      }
      if (toolCall.name === 'delete_file') {
        const relPath = String(toolCall.input.relPath ?? '');
        if (relPath) this.deletedFiles.add(relPath);
      }
    } catch {
      // 解析失败时保守处理，不记录文件变更
    }
  }

  /**
   * 从 unified diff 文本中提取被修改的文件路径列表。
   * 兼容 `+++ b/path/to/file` 以及带时间戳的格式，忽略 `/dev/null`（删除目标）。
   */
  private extractPatchFilePaths(patchText: string): string[] {
    const paths = new Set<string>();
    for (const line of patchText.split('\n')) {
      if (!line.startsWith('+++ ')) continue;
      const raw = line.slice(4).split('\t')[0].trim();
      const path = raw.replace(/^(a\/|b\/)/, '');
      if (path && path !== '/dev/null') {
        paths.add(path);
      }
    }
    return Array.from(paths);
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
        const input =
          c.input && typeof c.input === 'object' && !Array.isArray(c.input)
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

  private parseValidateResult(result: ToolResult): {
    lint: boolean;
    typecheck: boolean;
    lintReason?: string;
    typecheckReason?: string;
  } {
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

  private async handleFinish(finishCall: ToolCall): Promise<FixAttemptResult> {
    const success = finishCall.input.success === true;
    const reason = String(finishCall.input.reason ?? '');
    const hasNoFileChanges = this.appliedFiles.size === 0 && this.deletedFiles.size === 0;
    const claimsAlreadyFixed =
      finishCall.input.alreadyFixed === true || (!success && looksLikeAlreadyFixedClaim(reason));

    if (hasNoFileChanges && claimsAlreadyFixed) {
      const rechecked = await this.tryRecheckAlreadyFixed();
      if (rechecked) return rechecked;
      return {
        success: false,
        reason: [
          '模型判断问题已经修复，但框架回查未确认该结论。',
          this.lastRecheckVerdict?.reason ?? (reason || '未提供可验证证据'),
        ].join(' '),
      };
    }

    if (success) {
      if (hasNoFileChanges) {
        const rechecked = await this.tryRecheckAlreadyFixed();
        if (rechecked) return rechecked;
      }

      // LLM 可能直接调用 finish 却忘记调用 validate；自动补一次验证，避免"未调用 validate"的误判。
      if (!this.lastValidationResult?.passed) {
        const raw = await this.worktreeManager.validate();
        this.lastValidationResult = await this.validationStrategy.evaluate({
          worktreeManager: this.worktreeManager,
          appliedFiles: Array.from(this.appliedFiles),
          deletedFiles: Array.from(this.deletedFiles),
          rawResult: raw,
          baseline: this.baselineResult,
        });
      }

      if (!this.lastValidationResult?.passed) {
        return {
          success: false,
          reason: this.promptLoader.load('fix-tool-loop-validation-failure-reason', {
            reason: this.lastValidationResult?.reason ?? '未调用 validate',
          }),
        };
      }

      if (hasNoFileChanges) {
        return {
          success: false,
          reason: this.promptLoader.load('fix-tool-loop-no-change-failure-reason'),
        };
      }
    }

    return {
      success,
      reason: reason || (success ? '修复已完成并通过验证' : '修复未能完成'),
    };
  }
}
