/**
 * 工具执行器
 *
 * 将 LLM 输出的 tool call 映射到实际的 worktree / 记忆操作。
 * 所有副作用都在 worktree 内完成，run_script 受白名单控制。
 */

import type { ToolCall, ToolResult } from '../../../llm/tool-types.js';
import type { WorktreeManager } from '../../worktree/worktree-manager.js';
import type { IMemoryClient } from '../../memory/types.js';
import type { RecallPlanner } from '../../memory/recall-planner.js';
import { focusedContextToString } from '../focused-context-streamer.js';
import { SetupCommandSafetyFilter } from './setup-command-safety-filter.js';

export interface ToolExecutorOptions {
  worktreeManager: WorktreeManager;
  memoryClient?: IMemoryClient;
  recallPlanner?: RecallPlanner;
  /** run_script 白名单，默认 ['lint','typecheck','build','test','compile:packages'] */
  allowedScripts?: string[];
}

import { writeFileSync, mkdirSync, existsSync, createReadStream, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const MAX_OUTPUT_LENGTH = 2000;
const MAX_FILE_CONTENT_LENGTH = 20000;
const OUTPUT_FILE_THRESHOLD = 4000;
const MAX_OUTPUT_PREVIEW_LENGTH = 800;
const MAX_READ_OUTPUT_FILE_SIZE = 512 * 1024;
const TOOL_OUTPUT_DIR = '.codekeeper-tool-outputs';

/** 截断文本，mode=head 保留头部，mode=tail 保留尾部 */
function truncateText(text: string, maxLen: number, mode: 'head' | 'tail' = 'tail'): string {
  if (text.length <= maxLen) {
    return text;
  }
  if (mode === 'tail') {
    return `...（省略前 ${text.length - maxLen} 字符）\n${text.slice(-maxLen)}`;
  }
  return `${text.slice(0, maxLen)}\n...（后省略 ${text.length - maxLen} 字符）`;
}

/** 把超长工具输出写入 worktree 临时文件，返回相对路径 */
function writeToolOutputFile(worktreePath: string, toolCallId: string, text: string): string {
  const safeId = toolCallId.replace(/[^a-zA-Z0-9-]/g, '_');
  const relPath = `${TOOL_OUTPUT_DIR}/${safeId}.log`;
  const fullPath = join(worktreePath, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text, 'utf-8');
  return relPath;
}

/** 读取输出文件；指定 tailLines 时只返回最后 N 行 */
async function readOutputFile(
  worktreePath: string,
  relPath: string,
  tailLines?: number
): Promise<string> {
  const fullPath = join(worktreePath, relPath);
  if (!existsSync(fullPath)) {
    throw new Error(`输出文件不存在: ${relPath}`);
  }
  const stats = statSync(fullPath);
  if (stats.size > MAX_READ_OUTPUT_FILE_SIZE && tailLines === undefined) {
    throw new Error(
      `输出文件过大（${stats.size} bytes），请使用 tailLines 参数读取尾部关键内容`
    );
  }

  if (tailLines === undefined || tailLines <= 0) {
    return readFileSync(fullPath, 'utf-8');
  }

  // 流式读取最后 N 行，避免加载大文件
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(fullPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length > tailLines) {
      lines.shift();
    }
  }
  return lines.join('\n');
}

interface RunResult {
  success: boolean;
  reason?: string;
}

function isRunResult(value: unknown): value is RunResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as RunResult).success === 'boolean'
  );
}

/** 对脚本/setup 命令的输出做摘要，超长时落盘 */
function formatRunResult(
  result: RunResult,
  worktreePath: string,
  toolCallId: string
): RunResult | { success: boolean; outputFile: string; summary: string; truncated: true } {
  if (!result.reason || result.reason.length <= OUTPUT_FILE_THRESHOLD) {
    return summarizeRunResult(result);
  }
  const outputFile = writeToolOutputFile(worktreePath, toolCallId, result.reason);
  const summary = truncateText(
    result.reason,
    MAX_OUTPUT_PREVIEW_LENGTH,
    result.success ? 'head' : 'tail'
  );
  return { success: result.success, outputFile, summary, truncated: true };
}

/** 对脚本/setup 命令的输出做摘要，避免把完整 stdout 塞进 tool_result */
function summarizeRunResult(result: RunResult): RunResult {
  if (!result.reason) {
    return result;
  }
  if (result.success) {
    // 成功时只需简要信息；若输出很长，保留第一行并提示总长度
    if (result.reason.length <= MAX_OUTPUT_LENGTH) {
      return result;
    }
    const firstLine = result.reason.split('\n')[0] ?? '';
    return {
      success: true,
      reason: `${firstLine}\n...（输出已截断，原始长度 ${result.reason.length} 字符）`,
    };
  }
  return { success: false, reason: truncateText(result.reason, MAX_OUTPUT_LENGTH, 'tail') };
}

interface ValidateResult {
  lint: boolean;
  typecheck: boolean;
  lintReason?: string;
  typecheckReason?: string;
}

function isValidateResult(value: unknown): value is ValidateResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'lint' in value &&
    typeof (value as ValidateResult).lint === 'boolean' &&
    'typecheck' in value &&
    typeof (value as ValidateResult).typecheck === 'boolean'
  );
}

/** 对 validate 输出做摘要/落盘 */
function formatValidateResult(
  result: ValidateResult,
  worktreePath: string,
  toolCallId: string
):
  | ValidateResult
  | (Omit<ValidateResult, 'lintReason' | 'typecheckReason'> & {
      lintSummary?: string;
      typecheckSummary?: string;
      outputFile?: string;
      truncated?: boolean;
    }) {
  const lintLong = (result.lintReason?.length ?? 0) > OUTPUT_FILE_THRESHOLD;
  const typecheckLong = (result.typecheckReason?.length ?? 0) > OUTPUT_FILE_THRESHOLD;

  if (!lintLong && !typecheckLong) {
    return summarizeValidateResult(result);
  }

  // 把过长的部分组合写入一个文件
  const sections: string[] = [];
  if (lintLong) {
    sections.push(`=== lint ===\n${result.lintReason}`);
  }
  if (typecheckLong) {
    sections.push(`=== typecheck ===\n${result.typecheckReason}`);
  }
  const outputFile = writeToolOutputFile(worktreePath, toolCallId, sections.join('\n\n'));

  return {
    lint: result.lint,
    typecheck: result.typecheck,
    lintSummary: lintLong
      ? truncateText(result.lintReason ?? '', MAX_OUTPUT_PREVIEW_LENGTH, result.lint ? 'head' : 'tail')
      : result.lintReason,
    typecheckSummary: typecheckLong
      ? truncateText(
          result.typecheckReason ?? '',
          MAX_OUTPUT_PREVIEW_LENGTH,
          result.typecheck ? 'head' : 'tail'
        )
      : result.typecheckReason,
    outputFile,
    truncated: true,
  };
}

/** 对 validate 输出做摘要：成功时尽量简短，失败时保留尾部关键信息 */
function summarizeValidateResult(result: ValidateResult): ValidateResult {
  return {
    lint: result.lint,
    typecheck: result.typecheck,
    lintReason: result.lint
      ? summarizeRunResult({ success: true, reason: result.lintReason }).reason
      : truncateText(result.lintReason ?? '', MAX_OUTPUT_LENGTH, 'tail'),
    typecheckReason: result.typecheck
      ? summarizeRunResult({ success: true, reason: result.typecheckReason }).reason
      : truncateText(result.typecheckReason ?? '', MAX_OUTPUT_LENGTH, 'tail'),
  };
}

/** 按工具类型对结果做截断/摘要/落盘，防止超长输出进入 LLM 上下文 */
function formatToolResult(
  toolName: string,
  toolCallId: string,
  worktreePath: string,
  result: unknown
): unknown {
  if (toolName === 'validate' && isValidateResult(result)) {
    return formatValidateResult(result, worktreePath, toolCallId);
  }
  if ((toolName === 'run_script' || toolName === 'run_setup_command') && isRunResult(result)) {
    return formatRunResult(result, worktreePath, toolCallId);
  }
  if (toolName === 'read_file' && typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.content === 'string' && obj.content.length > MAX_FILE_CONTENT_LENGTH) {
      const outputFile = writeToolOutputFile(worktreePath, toolCallId, obj.content);
      return {
        ...obj,
        content: truncateText(obj.content, MAX_FILE_CONTENT_LENGTH, 'head'),
        outputFile,
        truncated: true,
      };
    }
  }
  if (toolName === 'read_file' && typeof result === 'string' && result.length > MAX_FILE_CONTENT_LENGTH) {
    const outputFile = writeToolOutputFile(worktreePath, toolCallId, result);
    return {
      content: truncateText(result, MAX_FILE_CONTENT_LENGTH, 'head'),
      outputFile,
      truncated: true,
    };
  }
  return result;
}

export class ToolExecutor {
  private readonly worktreeManager: WorktreeManager;
  private readonly memoryClient?: IMemoryClient;
  private readonly recallPlanner?: RecallPlanner;
  private readonly allowedScripts: Set<string>;
  private readonly setupCommandFilter = new SetupCommandSafetyFilter();

  constructor(options: ToolExecutorOptions) {
    this.worktreeManager = options.worktreeManager;
    this.memoryClient = options.memoryClient;
    this.recallPlanner = options.recallPlanner;
    this.allowedScripts = new Set(options.allowedScripts ?? ['lint', 'typecheck', 'build', 'test', 'compile:packages']);
  }

  /**
   * 执行单个 tool call，返回 tool result
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const result = await this.executeTool(toolCall.name, toolCall.input);
      const worktreePath = this.worktreeManager.getWorktreePath();
      const formatted = formatToolResult(toolCall.name, toolCall.id, worktreePath, result);
      return {
        tool_use_id: toolCall.id,
        content: JSON.stringify({ success: true, data: formatted }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        tool_use_id: toolCall.id,
        content: JSON.stringify({ success: false, error: message }),
        is_error: true,
      };
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'read_file':
        return this.readFile(input);
      case 'write_file':
        return this.writeFile(input);
      case 'delete_file':
        return this.deleteFile(input);
      case 'apply_patch':
        return this.applyPatch(input);
      case 'run_setup_command':
        return this.runSetupCommand(input);
      case 'run_script':
        return this.runScript(input);
      case 'validate':
        return this.validate();
      case 'read_output_file':
        return this.readOutputFile(input);
      case 'recall_memory':
        return this.recallMemory(input);
      case 'get_file_overview':
        return this.getFileOverview(input);
      case 'search_in_file':
        return this.searchInFile(input);
      case 'search_workspace':
        return this.searchWorkspace(input);
      case 'finish':
        return { finished: true };
      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  private async readOutputFile(input: Record<string, unknown>): Promise<{ content: string; tailLines?: number }> {
    const outputFile = this.requireString(input, 'outputFile');
    const tailLines = this.optionalNumber(input, 'tailLines');
    const worktreePath = this.worktreeManager.getWorktreePath();
    const content = await readOutputFile(worktreePath, outputFile, tailLines);
    return { content, tailLines };
  }

  private async readFile(input: Record<string, unknown>): Promise<unknown> {
    const relPath = this.requireString(input, 'relPath');
    const resolved = await this.worktreeManager.resolveFilePath(relPath);
    if (!resolved) {
      throw new Error(`无法解析文件路径: ${relPath}`);
    }

    const startLine = this.optionalNumber(input, 'startLine');
    const endLine = this.optionalNumber(input, 'endLine');
    const targetLine = this.optionalNumber(input, 'targetLine');
    const windowLines = this.optionalNumber(input, 'windowLines');

    if (startLine !== undefined && endLine !== undefined) {
      const content = await this.worktreeManager.readFileRange(resolved, startLine, endLine);
      return { content, startLine, endLine };
    }

    if (targetLine !== undefined) {
      const focused = await this.worktreeManager.readFileWindow(
        resolved,
        {
          file: resolved,
          line: targetLine,
          severity: 'MEDIUM',
          message: '',
          suggestion: '',
        },
        { maxLines: windowLines ?? 80 }
      );
      return {
        content: focusedContextToString(focused),
        startLine: focused.snippetStartLine,
        endLine: focused.snippetEndLine,
      };
    }

    return this.worktreeManager.readFile(resolved);
  }

  private async getFileOverview(input: Record<string, unknown>): Promise<unknown> {
    const relPath = this.requireString(input, 'relPath');
    const resolved = await this.worktreeManager.resolveFilePath(relPath);
    if (!resolved) {
      throw new Error(`无法解析文件路径: ${relPath}`);
    }
    return this.worktreeManager.getFileOverview(resolved);
  }

  private async searchInFile(input: Record<string, unknown>): Promise<unknown> {
    const relPath = this.requireString(input, 'relPath');
    const keyword = this.requireString(input, 'keyword');
    const resolved = await this.worktreeManager.resolveFilePath(relPath);
    if (!resolved) {
      throw new Error(`无法解析文件路径: ${relPath}`);
    }
    return this.worktreeManager.searchInFile(resolved, keyword);
  }

  private async searchWorkspace(input: Record<string, unknown>): Promise<unknown> {
    const keyword = this.requireString(input, 'keyword');
    return this.worktreeManager.searchWorkspace(keyword);
  }

  private async writeFile(input: Record<string, unknown>): Promise<{ written: true; unchanged: boolean; appended: boolean }> {
    const relPath = this.requireString(input, 'relPath');
    // content 允许为空字符串：清空文件是合法的修复操作
    const content = this.requireContent(input);
    const mode = this.optionalWriteMode(input);
    const resolved = await this.worktreeManager.resolveFilePath(relPath);
    if (!resolved) {
      throw new Error(`无法解析文件路径: ${relPath}`);
    }
    if (mode === 'append') {
      this.worktreeManager.writeFile(resolved, content, 'append');
      // append 总是产生变更（除非追加空内容）
      return { written: true, unchanged: content.length === 0, appended: true };
    }
    const existing = this.worktreeManager.readFile(resolved);
    const unchanged = existing === content;
    this.worktreeManager.writeFile(resolved, content);
    return { written: true, unchanged, appended: false };
  }

  private optionalWriteMode(input: Record<string, unknown>): 'overwrite' | 'append' {
    const value = input.mode;
    return value === 'append' ? 'append' : 'overwrite';
  }

  /** content 参数校验：必须是字符串，但允许为空（清空文件） */
  private requireContent(input: Record<string, unknown>): string {
    const value = input.content;
    if (typeof value !== 'string') {
      throw new Error('参数 content 必须是字符串');
    }
    return value;
  }

  private async deleteFile(input: Record<string, unknown>): Promise<{ deleted: true }> {
    const relPath = this.requireString(input, 'relPath');
    const resolved = await this.worktreeManager.resolveFilePath(relPath);
    if (!resolved) {
      throw new Error(`无法解析文件路径: ${relPath}`);
    }
    await this.worktreeManager.removeFile(resolved);
    return { deleted: true };
  }

  private async applyPatch(input: Record<string, unknown>): Promise<{ applied: boolean }> {
    const patchText = this.requireString(input, 'patchText');
    const applied = await this.worktreeManager.applyPatch(patchText);
    if (!applied) {
      throw new Error('patch 应用失败');
    }
    return { applied: true };
  }

  private async runSetupCommand(input: Record<string, unknown>): Promise<{ success: boolean; reason?: string }> {
    const command = this.requireString(input, 'command');
    const cwd = this.optionalString(input, 'cwd');

    const filterResult = this.setupCommandFilter.check(command);
    if (!filterResult.allowed) {
      throw new Error(`命令被安全策略拦截: ${filterResult.reason}`);
    }

    return this.worktreeManager.runSetupCommand(command, cwd);
  }

  private async runScript(input: Record<string, unknown>): Promise<{ success: boolean; reason?: string }> {
    const script = this.requireString(input, 'script');
    if (!this.allowedScripts.has(script)) {
      throw new Error(`脚本 ${script} 不在白名单内，只允许: ${Array.from(this.allowedScripts).join(', ')}`);
    }
    const args = this.optionalStringArray(input, 'args');
    return args ? this.worktreeManager.runScript(script, args) : this.worktreeManager.runScript(script);
  }

  private async validate(): Promise<{
    lint: boolean;
    typecheck: boolean;
    lintReason?: string;
    typecheckReason?: string;
  }> {
    return this.worktreeManager.validate();
  }

  private async recallMemory(input: Record<string, unknown>): Promise<string[]> {
    const query = this.requireString(input, 'query');
    const type = this.optionalString(input, 'type');

    if (this.recallPlanner) {
      const plan = await this.recallPlanner.plan({
        role: 'maintainer',
        taskType: 'fix',
        taskSummary: `${type ?? 'general'} ${query}`,
      });
      if (plan.needsRecall && plan.queries.length > 0) {
        return this.recallPlanner.execute(plan);
      }
      return [];
    }

    if (!this.memoryClient) {
      return [];
    }

    switch (type) {
      case 'project_knowledge':
        return this.memoryClient.recallProjectKnowledge(query);
      case 'reviewer_preference':
        return this.memoryClient.recallUserPreferences(this.memoryClient.context.userId, query);
      case 'maintenance_history':
        return this.memoryClient.recallForMaintenance(query);
      default:
        return this.memoryClient.recallForMaintenance(query);
    }
  }

  private requireString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`参数 ${key} 必须是有效字符串`);
    }
    return value;
  }

  private optionalString(input: Record<string, unknown>, key: string): string | undefined {
    const value = input[key];
    return typeof value === 'string' ? value : undefined;
  }

  private optionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
    const value = input[key];
    if (!Array.isArray(value)) {
      return undefined;
    }
    const strings = value.filter((item): item is string => typeof item === 'string');
    return strings.length > 0 ? strings : undefined;
  }

  private optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    return typeof value === 'number' ? value : undefined;
  }
}
