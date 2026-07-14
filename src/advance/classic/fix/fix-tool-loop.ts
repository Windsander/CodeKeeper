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
  /** 额外系统提示 */
  extraSystemPrompt?: string;
  /** 验证策略，默认 WorkspaceValidationStrategy */
  validationStrategy?: ValidationStrategy;
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
  private readonly extraSystemPrompt: string;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly validationStrategy: ValidationStrategy;
  private readonly messages: LlmMessage[] = [];

  private appliedFiles = new Set<string>();
  private deletedFiles = new Set<string>();
  private baselineResult?: ValidationResult;
  private lastValidationResult?: ValidationResult;
  private fallbackId = 0;
  private truncationRetries = 0;
  private noToolCallRetries = 0;

  constructor(options: FixToolLoopOptions) {
    this.llmClient = options.llmClient;
    this.worktreeManager = options.worktreeManager;
    this.finding = options.finding;
    this.mr = options.mr;
    this.maxSteps = options.maxSteps ?? 20;
    this.maxTokens = options.maxTokens ?? 8192;
    this.maxTruncationRetries = options.maxTruncationRetries ?? 3;
    this.maxNoToolCallRetries = options.maxNoToolCallRetries ?? 2;
    this.extraSystemPrompt = options.extraSystemPrompt ?? '';
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
          content:
            '你上一条回复因长度限制被截断，未被执行。请直接调用工具、不要输出解释文字；' +
            '如需写入大文件，用 write_file 分段写入（第一段 overwrite，后续 append，每段约 100 行以内），' +
            '或改用 apply_patch 局部修改。',
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
          content:
            '你上一条回复没有调用任何工具。请必须使用提供的工具（read_file、apply_patch、write_file、validate、finish 等）来推进修复，' +
            '不要只用文字描述。如果确实无法确定如何修改，调用 finish({ success: false, reason: "需要 Reviewer 澄清具体修改方式" })。',
        });
        continue;
      }
      this.noToolCallRetries = 0;

      const toolResults = await this.executeToolCalls(toolCalls);

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

      const finishCall = toolCalls.find((tc: ToolCall) => tc.name === 'finish');
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
    return [
      '你是 CodeKeeper Maintainer Agent，负责在隔离的 git worktree 中修复代码。',
      '',
      '工作原则：',
      '1. 所有修改必须在 worktree 内进行，不能影响主仓库。',
      '2. 你只能使用提供的工具操作 worktree；不能运行任意 shell 命令。',
      '3. run_script 只能调用 package.json 中白名单内的 npm scripts（lint、typecheck、build、test、compile:packages）。',
      '4. 修改前必须先 read_file 查看目标文件的当前内容，确认现状后再改；禁止不读文件凭猜测修改。跨文件修改需分别读写相关文件。',
      '5. 写入协议：局部修改优先用 apply_patch；write_file 整文件覆盖仅限小文件（约 100 行以内）；写入更大的文件必须分段（第一段 overwrite，后续 append，每段约 100 行以内）。',
      `6. 你必须把修复应用到 finding 指出的目标文件（${this.finding.file}）。如果修改涉及导出/导入，可同步修改相关文件，但核心改动必须在目标文件上。`,
      '7. 调用 write_file 后，如果返回 unchanged=true，说明写入内容和原文件完全一致，没有产生任何变更；此时你必须检查是否写错了文件，并重新修改正确的文件。',
      '8. 如果 worktree 的运行环境尚未准备好（例如缺少 node_modules、workspace 包未编译、Rust/Python/Go 依赖未安装），你可以先使用 run_setup_command 安装或构建，再读取和修改文件。run_setup_command 仅用于安装/构建，禁止用于 git、find、grep 等查询命令。',
      '9. 如果阅读目标文件后仍无法确定 Reviewer 期望的具体修改，不要反复搜索或猜测，直接调用 finish({ success: false, reason: "需要 Reviewer 澄清具体修改方式" })，避免耗尽步数。',
      '10. 完成修改后，必须调用 validate 确认 lint 和 typecheck 通过。',
      '11. 若修复成功并通过验证，调用 finish({ success: true, reason: "..." })。',
      '12. 若无法修复、验证失败或需要 Reviewer 澄清，调用 finish({ success: false, reason: "..." })。',
      '13. 回复要简洁，直接调用工具，不要输出长篇解释；如果输出被截断，优先保证工具调用完整。',
      '14. 不能直接提交或推送代码，提交由框架在循环外统一处理。',
      this.extraSystemPrompt,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildTaskPrompt(): string {
    return [
      '请修复以下代码问题。',
      '',
      `目标文件: ${this.finding.file}`,
      `行号: ${this.finding.line}`,
      `问题: ${this.finding.message}`,
      `建议: ${this.finding.suggestion ?? '无'}`,
      `严重程度: ${this.finding.severity}`,
      '',
      `MR: ${this.mr.title}`,
      `源分支: ${this.mr.sourceBranch}`,
      `目标分支: ${this.mr.targetBranch}`,
      '',
      `请重点修改 ${this.finding.file}，按工作原则使用工具完成修复。`,
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
