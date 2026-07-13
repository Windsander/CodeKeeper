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
      return {
        tool_use_id: toolCall.id,
        content: JSON.stringify({ success: true, data: result }),
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
      case 'recall_memory':
        return this.recallMemory(input);
      case 'get_file_overview':
        return this.getFileOverview(input);
      case 'search_in_file':
        return this.searchInFile(input);
      case 'finish':
        return { finished: true };
      default:
        throw new Error(`未知工具: ${name}`);
    }
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

  private async writeFile(input: Record<string, unknown>): Promise<{ written: true; unchanged: boolean }> {
    const relPath = this.requireString(input, 'relPath');
    const content = this.requireString(input, 'content');
    const resolved = await this.worktreeManager.resolveFilePath(relPath);
    if (!resolved) {
      throw new Error(`无法解析文件路径: ${relPath}`);
    }
    const existing = this.worktreeManager.readFile(resolved);
    const unchanged = existing === content;
    this.worktreeManager.writeFile(resolved, content);
    return { written: true, unchanged };
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
    return this.worktreeManager.runScript(script);
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

  private optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    return typeof value === 'number' ? value : undefined;
  }
}
