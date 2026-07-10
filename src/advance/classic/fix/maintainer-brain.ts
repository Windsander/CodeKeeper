import type { ReviewFinding } from '../provider/types.js';
import { LlmClient, LlmDecisionError } from '../../llm/client.js';
import type { ToolDefinition } from '../../llm/tool-types.js';
import type { IMemoryClient } from '../memory/types.js';
import { IssueScopeClassifier, type IssueScope } from './issue-scope.js';
import { buildFocusedContext, type FocusedContext } from './focused-context-builder.js';
import { focusedContextToString } from './focused-context-streamer.js';
import { buildFindingCaseKey } from '../memory/finding-case-key.js';
import type { RecallPlanner } from '../memory/recall-planner.js';
import { CognitiveEngine } from '../cognitive-engine.js';
import type { CognitiveDecision, MrContext } from './cognitive-types.js';
import type { EnvironmentPrepContext, EnvironmentPrepDecision } from './fix-result.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { FileOverview } from '../worktree/file-overview-builder.js';
import {
  summarizeThreadNotes,
  formatThreadContext,
  type ThreadContext,
} from '../utils/context-window.js';
import { logMemorySnapshot } from '../utils/memory-snapshot.js';

const PARSE_FINDINGS_TOOL: ToolDefinition = {
  name: 'parse_findings',
  description: '从代码评审评论中提取所有可修复的代码问题',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
            file: { type: 'string' },
            line: { type: 'number' },
            ruleId: { type: 'string' },
            message: { type: 'string' },
            suggestion: { type: 'string' },
            autoFixable: { type: 'boolean' },
          },
          required: ['severity', 'file', 'line', 'message', 'suggestion'],
          additionalProperties: true,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
};

const MAINTAINER_REPLY_DECISION_TOOL: ToolDefinition = {
  name: 'maintainer_reply_decision',
  description: '根据 discussion 历史决定下一步动作',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['fix', 'ask', 'ignore'] },
      reason: { type: 'string' },
      question: { type: 'string' },
      fixDescription: { type: 'string' },
      deleteFile: { type: 'boolean' },
    },
    required: ['action', 'reason'],
    additionalProperties: false,
  },
};

const ENV_PREP_DECISION_TOOL: ToolDefinition = {
  name: 'env_prep_decision',
  description: '根据 typecheck 失败输出决定是否需要运行某个 npm script 准备环境',
  input_schema: {
    type: 'object',
    properties: {
      script: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

/**
 * Maintainer 对单条 finding/discussion 可执行的最终动作
 */
export type MaintainerAction = 'fix' | 'ask' | 'ignore';

/**
 * MaintainerBrain 的决策结果
 */
export interface MaintainerDecision {
  /** 下一步动作 */
  action: MaintainerAction;
  /** 决策理由 */
  reason: string;
  /** 当 action 为 ask 时，要向 Reviewer 提出的问题 */
  question?: string;
  /** 当 action 为 fix 时，可选的修复描述（用于交互式回复场景） */
  fixDescription?: string;
  /** 问题范围分类，用于决定修复策略 */
  scope?: IssueScope;
  /** 当 action 为 fix 且 Reviewer 要求从 MR 中移除某个文件时标记为 true */
  deleteFile?: boolean;
}

export interface MaintainerBrainOptions {
  /** LLM 客户端 */
  llmClient: LlmClient;
  /** 允许自动修复的风险等级列表，未提供则默认全部允许 */
  allowedRiskLevels?: string[];
  /** MR Agent 个性/策略配置（SOUL.md 内容） */
  soulContent?: string;
  /** 项目自动归纳的智库内容（context.md 摘要） */
  projectContext?: string;
  /** 可选的记忆客户端，用于记录修复尝试 */
  memoryClient?: IMemoryClient;
  /** 可选的记忆查询规划器，让 Agent 按需决定查什么记忆 */
  recallPlanner?: RecallPlanner;
  /** 认知深度，默认 standard */
  cognitiveDepth?: 'fast' | 'standard' | 'deep';
  /** 可选的 worktree 管理器，用于获取文件概览和扩展读取 */
  worktreeManager?: WorktreeManager;
}

export interface ParseFindingsInput {
  body: string;
  position?: { newPath?: string; newLine?: number; oldPath?: string; oldLine?: number };
  isSummary?: boolean;
}

/**
 * MaintainerBrain
 *
 * Maintainer 的“大脑”：根据文件内容、finding、原始评论或 discussion thread，
 * 由 LLM 自主决定：
 * - 直接修复（fix）
 * - 向 Reviewer 提问澄清（ask）
 * - 忽略本 discussion（ignore）
 */
export class MaintainerBrain {
  private readonly allowedRiskLevels: string[];

  constructor(private readonly options: MaintainerBrainOptions) {
    this.allowedRiskLevels = options.allowedRiskLevels ?? ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  }

  /**
   * 初次看到一条 finding / discussion 时做决策
   */
  async decide(params: {
    finding: ReviewFinding;
    fileContent: string | FocusedContext;
    /** 原始评论内容，优先于 finding.message 用于理解 Reviewer 意图 */
    originalComment?: string;
    /** MR 在 GitLab 中的 IID，用于记忆关联 */
    mrIid: number;
    /** discussion 发起者（远端 Reviewer / 用户），用于召回用户偏好 */
    userId: string;
    /** MR 级上下文（可选） */
    mrContext?: MrContext;
    /** 同 MR 其他相关 findings（可选） */
    relatedFindings?: ReviewFinding[];
  }): Promise<CognitiveDecision> {
    const { finding, fileContent, originalComment, mrIid, userId, mrContext, relatedFindings } = params;

    // 风险等级未开启时，不直接修复，而是询问 Reviewer 如何处理
    if (!this.allowedRiskLevels.includes(finding.severity)) {
      return {
        action: 'ask',
        reason: `${finding.severity} 风险等级未开启自动修复`,
        question: `该 finding 的风险等级为 ${finding.severity}，当前未开启自动修复。请 Reviewer 确认是否需要我处理，或指定处理方式。`,
        analysis: '风险等级未开启',
        consideredOptions: [],
        reasoning: '当前配置不自动处理该风险等级',
        confidence: 'high',
      };
    }

    const recalledMemories = await this.recallMemories(userId, finding, originalComment);
    logMemorySnapshot('MaintainerBrain.decide 召回记忆后');
    console.log(`[MaintainerBrain] recalledMemories 数量=${recalledMemories.length}, 总字符=${recalledMemories.reduce((sum, m) => sum + m.length, 0)}`);

    const focusedContext =
      typeof fileContent === 'string'
        ? buildFocusedContext(fileContent, finding)
        : fileContent;
    const classification = await new IssueScopeClassifier({
      llmClient: this.options.llmClient,
    }).classify(finding, focusedContext);
    logMemorySnapshot('MaintainerBrain.decide 范围分类后');

    if (classification.scope === 'needs-clarification') {
      return {
        action: 'ask',
        reason: classification.reason,
        question: '请补充问题所在的文件路径、行号或更具体的修改建议。',
        scope: classification.scope,
        analysis: '缺少足够上下文',
        consideredOptions: [],
        reasoning: classification.reason,
        confidence: 'low',
      };
    }

    const fileOverview = this.options.worktreeManager
      ? await this.safeGetFileOverview(finding.file)
      : undefined;
    logMemorySnapshot('MaintainerBrain.decide 获取文件概览后');

    const engine = new CognitiveEngine({
      llmClient: this.options.llmClient,
      recallPlanner: this.options.recallPlanner,
      memoryClient: this.options.memoryClient,
      worktreeManager: this.options.worktreeManager,
    });

    logMemorySnapshot('MaintainerBrain.decide 调用认知引擎前');
    let decision: CognitiveDecision;
    try {
      decision = await engine.decide(
        {
          finding,
          fileContent: this.buildFocusedFileContent(focusedContext),
          originalComment: originalComment ?? '',
          mrContext: mrContext ?? {
            iid: mrIid,
            title: '',
            sourceBranch: '',
            targetBranch: '',
            description: '',
            diffSummary: '',
            changedFiles: [],
          },
          relatedFindings: relatedFindings ?? [],
          recalledMemories,
          fileOverview,
          extraFileContexts: [],
          projectContext: this.options.projectContext,
          soulContent: this.options.soulContent,
        },
        this.options.cognitiveDepth ?? 'standard'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof LlmDecisionError) {
        console.warn('[MaintainerBrain] 决策工具调用失败，保守询问:', message);
        decision = {
          action: 'ask',
          reason: `决策工具调用失败：${message}`,
          question: '我没有完全理解你的意思，能否再说得具体一些？',
          analysis: '决策工具调用失败',
          consideredOptions: [],
          reasoning: '决策工具调用失败，保守询问',
          confidence: 'low',
        };
      } else {
        throw err;
      }
    }
    logMemorySnapshot('MaintainerBrain.decide 认知引擎返回后');

    if (this.options.memoryClient) {
      await this.options.memoryClient.recordFixAttempt({
        mrIid,
        file: finding.file,
        line: finding.line,
        success: decision.action === 'fix',
        reason: decision.reason,
      });
    }

    return {
      ...decision,
      scope: decision.scope && decision.scope !== 'local' ? decision.scope : classification.scope,
    };
  }

  /**
   * 从评论内容中解析可修复的 finding 列表
   */
  async parseFindings(input: ParseFindingsInput): Promise<ReviewFinding[]> {
    const markdownFindings = this.parseFindingsFromMarkdown(input.body, input.position);
    if (markdownFindings.length > 0) {
      return markdownFindings;
    }

    const prompt = this.buildParseFindingsPrompt(input);
    const toolCall = await this.options.llmClient.completeDecision(
      [PARSE_FINDINGS_TOOL],
      prompt,
      '你是代码评审解析助手，必须从 parse_findings 工具输出解析结果'
    );
    return this.extractFindingsFromResponse(toolCall.input, input.position);
  }

  private async recallMemories(
    userId: string,
    finding: ReviewFinding,
    originalComment?: string
  ): Promise<string[]> {
    // 优先使用 RecallPlanner 让 Agent 自己决定查什么记忆
    if (this.options.recallPlanner) {
      const query = `${finding.file} ${finding.line} ${finding.message} ${originalComment ?? ''}`.slice(0, 2000);
      const plan = await this.options.recallPlanner.plan({
        role: 'maintainer',
        taskType: 'fix',
        taskSummary: query,
      });
      if (!plan.needsRecall || plan.queries.length === 0) return [];
      const memories = await this.options.recallPlanner.execute(plan);
      return memories;
    }

    // fallback：未提供 planner 时维持原有三路查询
    if (!this.options.memoryClient) return [];
    const query = `${finding.file} ${finding.line} ${finding.message} ${originalComment ?? ''}`.slice(
      0,
      2000
    );
    const [userPrefs, projectKnowledge, maintenanceMemories] = await Promise.all([
      this.options.memoryClient.recallUserPreferences(userId, query),
      this.options.memoryClient.recallProjectKnowledge(query),
      this.options.memoryClient.recallForMaintenance(query),
    ]);

    const memories: string[] = [];
    if (userPrefs.length > 0) {
      memories.push(`用户偏好：\n${userPrefs.map((m) => `- ${m}`).join('\n')}`);
    }
    if (projectKnowledge.length > 0) {
      memories.push(`项目知识：\n${projectKnowledge.map((m) => `- ${m}`).join('\n')}`);
    }
    if (maintenanceMemories.length > 0) {
      memories.push(`维护历史：\n${maintenanceMemories.map((m) => `- ${m}`).join('\n')}`);
    }
    return memories;
  }

  /**
   * 把聚焦上下文拼成一段带 imports 的代码内容，供认知引擎使用
   */
  private buildFocusedFileContent(focusedContext: FocusedContext): string {
    return focusedContextToString(focusedContext);
  }

  /**
   * 安全获取文件概览，失败时返回 undefined 不影响主流程
   */
  private async safeGetFileOverview(filePath: string): Promise<FileOverview | undefined> {
    if (!this.options.worktreeManager) return undefined;
    try {
      return await this.options.worktreeManager.getFileOverview(filePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[MaintainerBrain] 获取文件概览 ${filePath} 失败: ${message}`);
      return undefined;
    }
  }

  /**
   * 已经向 Reviewer 提问后，根据 Reviewer 的后续回复决定下一步
   */
  async decideReply(params: {
    filePath: string;
    fileContent: string | FocusedContext;
    threadNotes: Array<{ author: string; body: string; createdAt: string }>;
    maintainerName: string;
  }): Promise<MaintainerDecision> {
    const threadContext = await summarizeThreadNotes(
      this.options.llmClient,
      params.threadNotes,
      { maxRawTokens: 8000, maxRecentItems: 5 }
    );
    const fileContentString =
      typeof params.fileContent === 'string'
        ? params.fileContent
        : focusedContextToString(params.fileContent);
    const prompt = this.buildReplyPrompt(
      params.filePath,
      fileContentString,
      threadContext,
      params.maintainerName
    );
    const toolCall = await this.options.llmClient.completeDecision(
      [MAINTAINER_REPLY_DECISION_TOOL],
      prompt,
      this.systemPrompt()
    );
    return this.parseDecisionFromToolCall(toolCall);
  }

  /**
   * 当校验因 workspace 包未编译等环境问题失败时，由 LLM 决定执行哪个 npm script 修复环境
   */
  async decideEnvironmentPrep(context: EnvironmentPrepContext): Promise<EnvironmentPrepDecision> {
    const prompt = [
      '修复 patch 已应用，但 typecheck 失败。请根据以下信息判断是否需要先运行某个 npm script 来准备环境。',
      '',
      '## 可用的 npm scripts',
      context.availableScripts.length > 0
        ? context.availableScripts.map((s) => `- ${s}`).join('\n')
        : '（未能读取到 package.json scripts）',
      '',
      '## typecheck 原始输出（节选）',
      '```',
      context.validateOutput.slice(0, 4000),
      '```',
      '',
      '请从 env_prep_decision 工具输出决策。',
    ].join('\n');

    try {
      const toolCall = await this.options.llmClient.completeDecision(
        [ENV_PREP_DECISION_TOOL],
        prompt,
        '你是项目构建环境诊断助手，必须从 env_prep_decision 工具输出决策'
      );
      const parsed = toolCall.input as { script?: string; reason?: string };
      if (typeof parsed.script === 'string' && context.availableScripts.includes(parsed.script)) {
        return { script: parsed.script, reason: parsed.reason ?? '已选择环境准备脚本' };
      }
      return { reason: parsed.reason ?? 'LLM 未选择可用脚本' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[MaintainerBrain] 环境准备决策工具调用失败:', message);
      return { reason: '无法解析 LLM 环境准备决策，保守跳过' };
    }
  }

  private buildParseFindingsPrompt(input: ParseFindingsInput): string {
    const positionHint = input.position?.newPath
      ? `该评论所在文件：${input.position.newPath}，行号：${input.position.newLine ?? '未知'}`
      : '评论中没有文件定位信息。';

    return `请从以下代码评审评论中提取所有可修复的代码问题，输出 JSON 对象。

评论内容：
${input.body}

${positionHint}

评论可能是以下格式之一：
1. Markdown 列表：
   - \`src/a.ts:10\` · 规则 \`no-any\` 类型不安全
     **修改建议**：使用具体类型
   - \`src/b.ts:25\` · 规则 \`unused\` 变量未使用
     **修改建议**：删除变量
2. 普通文本段落：
   "src/a.ts 第 10 行的 any 建议改成具体类型；另外 src/b.ts 第 25 行的变量未使用，建议删除。"
3. 对文件的描述性说明（可能包含多个具体问题）。

输出格式：
{
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "file": "文件路径",
      "line": 123,
      "ruleId": "可选的规则编号",
      "message": "问题描述",
      "suggestion": "修改建议",
      "autoFixable": true
    }
  ]
}

注意：
- 一条评论中可能包含多个问题，请全部提取。
- 如果评论里没有需要修复的代码问题，findings 为空数组。
- 如果评论是机器人签名、系统提示或 Maintainer 自己的回复，findings 为空数组。
- 当评论中没有明确文件路径时，使用上面提供的文件和行号作为兜底。
- 不要输出任何 JSON 以外的内容。`;
  }

  private extractFindingsFromResponse(
    input: Record<string, unknown>,
    position?: ParseFindingsInput['position']
  ): ReviewFinding[] {
    let parsed: unknown[] = [];
    if (Array.isArray(input)) {
      parsed = input;
    } else if (input && typeof input === 'object' && 'findings' in input && Array.isArray(input.findings)) {
      parsed = input.findings as unknown[];
    } else {
      return [];
    }

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => {
        let file = String(item.file ?? '');
        let line = Number(item.line ?? 0);
        if ((!file || line <= 0) && position) {
          file = file || (position.newPath ?? position.oldPath ?? '');
          line = line > 0 ? line : (position.newLine ?? position.oldLine ?? 1);
        }
        return {
          severity: this.normalizeSeverity(String(item.severity ?? 'MEDIUM')),
          file,
          line: line > 0 ? line : 1,
          ruleId: item.ruleId ? String(item.ruleId) : undefined,
          message: String(item.message ?? '未描述的问题'),
          suggestion: String(item.suggestion ?? '请查看 discussion 详情'),
          autoFixable: item.autoFixable === true,
        };
      });
  }

  private parseFindingsFromMarkdown(
    body: string,
    position?: ParseFindingsInput['position']
  ): ReviewFinding[] {
    // 去掉 Agent 签名 footer 之后的内容
    const bodyWithoutFooter = body.split('\n---\n')[0] ?? body;
    const lines = bodyWithoutFooter.split('\n');
    const findings: ReviewFinding[] = [];
    let current: Partial<ReviewFinding> | null = null;

    // 匹配常见文件路径 + 行号，例如 src/a.ts:10、./src/a.ts:10
    const fileLinePattern = /\b([\w\-./]+\.[a-zA-Z0-9]+):(\d+)\b/;
    // 匹配常见列表标记：- * + 或 1. 2.
    const listMarkerPattern = /^([-+*]\s+|\d+\.\s+)/;

    const finalizeCurrent = () => {
      if (current) {
        findings.push(this.finalizeFinding(current, position));
        current = null;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (current && line.startsWith('**问题描述**：')) {
        current.message = line.replace('**问题描述**：', '').trim();
        continue;
      }

      if (current && line.startsWith('**修改建议**：')) {
        current.suggestion = line.replace('**修改建议**：', '').trim();
        continue;
      }

      if (current && line.startsWith('**建议**：')) {
        current.suggestion = line.replace('**建议**：', '').trim();
        continue;
      }

      const fileLineMatch = line.match(fileLinePattern);
      const hasListMarker = listMarkerPattern.test(line);

      // 把包含文件定位的新行视为一个新 finding 的开始
      if (fileLineMatch || hasListMarker) {
        finalizeCurrent();
        current = { severity: 'MEDIUM' };

        if (fileLineMatch) {
          current.file = fileLineMatch[1];
          current.line = parseInt(fileLineMatch[2], 10);
        }

        const ruleMatch = line.match(/规则\s+`([^`]+)`/);
        if (ruleMatch) current.ruleId = ruleMatch[1];

        let message = line
          .replace(listMarkerPattern, '')
          .replace(fileLinePattern, '')
          .replace(/·\s*规则\s+`[^`]+`/, '')
          .replace(/`/g, '')
          .trim();
        // 去掉常见的 severity emoji/前缀
        message = message.replace(
          /^[\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{26AA}]+\s*/u,
          ''
        ).trim();
        if (message) current.message = message;
        continue;
      }

      if (current) {
        current.message = current.message ? `${current.message}\n${line}` : line;
      }
    }

    finalizeCurrent();
    return findings.filter((f) => f.file && f.line > 0);
  }

  private finalizeFinding(
    partial: Partial<ReviewFinding>,
    position?: ParseFindingsInput['position']
  ): ReviewFinding {
    let file = partial.file ?? '';
    let line = partial.line ?? 0;
    if ((!file || line <= 0) && position) {
      file = file || (position.newPath ?? position.oldPath ?? '');
      line = line > 0 ? line : (position.newLine ?? position.oldLine ?? 1);
    }
    return {
      severity: this.normalizeSeverity(partial.severity ?? 'MEDIUM'),
      file: file || '',
      line: line > 0 ? line : 1,
      ruleId: partial.ruleId,
      message: partial.message ?? '未描述的问题',
      suggestion: partial.suggestion ?? '请查看 discussion 详情',
      autoFixable: partial.autoFixable ?? false,
    };
  }

  /**
   * 用 EverOS 中的 reviewer case 丰富 finding 的 message/suggestion/ruleId
   */
  async enrichFindingsWithCases(findings: ReviewFinding[], mrIid: number): Promise<ReviewFinding[]> {
    const memoryClient = this.options.memoryClient;
    if (!memoryClient) return findings;
    const projectId = memoryClient.context.projectId;

    const enriched = await Promise.all(
      findings.map(async (finding) => {
        const key = buildFindingCaseKey({
          projectId,
          mrIid,
          file: finding.file,
          line: finding.line,
          ruleId: finding.ruleId,
        });
        try {
          const items = await memoryClient.recallFindingCase(key);
          const c = this.parseCaseContent(items, key);
          if (!c) return finding;
          return {
            ...finding,
            message: c.message || finding.message,
            suggestion: c.suggestion || finding.suggestion,
            ruleId: c.ruleId || finding.ruleId,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[MaintainerBrain] 召回 case ${key} 失败: ${message}`);
          return finding;
        }
      })
    );

    return enriched;
  }

  private parseCaseContent(
    items: string[],
    key: string
  ): { message?: string; suggestion?: string; ruleId?: string; status?: string } | null {
    const text = items.find((item) => item.includes(`[CASE:${key}]`));
    if (!text) return null;

    const ruleMatch = text.match(/规则:\s*(.+)/);
    const messageMatch = text.match(/问题:\s*(.+)/);
    const suggestionMatch = text.match(/建议:\s*(.+)/);
    const statusMatch = text.match(/状态:\s*(.+)/);

    return {
      ruleId: ruleMatch?.[1].trim(),
      message: messageMatch?.[1].trim(),
      suggestion: suggestionMatch?.[1].trim(),
      status: statusMatch?.[1].trim(),
    };
  }

  private normalizeSeverity(severity: string): ReviewFinding['severity'] {
    const valid: ReviewFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const upper = severity.toUpperCase();
    return valid.includes(upper as ReviewFinding['severity']) ? (upper as ReviewFinding['severity']) : 'MEDIUM';
  }

  private systemPrompt(): string {
    const soulSection = this.options.soulContent
      ? `\n\nAgent 个性与策略（SOUL.md）：\n${this.options.soulContent}`
      : '';
    const contextSection = this.options.projectContext
      ? `\n\n项目背景与智库：\n${this.options.projectContext}`
      : '';

    return [
      '你是一名谨慎的代码维护助手（Maintainer Agent）。',
      '你会收到代码文件内容和 Reviewer 在 MR discussion 中提出的意见。',
      `评审规则：根据 Reviewer 意见处理问题并尝试自动修复${soulSection}${contextSection}`,
      '请根据你对问题的理解，自主决定下一步动作：',
      '- "fix"：你确信可以根据 Reviewer 的意见做出最小且正确的代码修改。请同时给出简要修复描述。',
      '- "ask"：评论含糊、缺少上下文、或你不确定如何安全修改。请直接向 Reviewer 提出一个简洁、有针对性的澄清问题。',
      '- "ignore"：评论明显不需要代码改动（例如只是赞美、已过期、或不相关）。请说明原因。',
      '只能输出 JSON，不要输出任何解释文字。',
    ].join('\n');
  }

  private buildReplyPrompt(
    filePath: string,
    fileContent: string,
    threadContext: ThreadContext,
    maintainerName: string
  ): string {
    const threadText = formatThreadContext(threadContext);

    return [
      '## 文件路径',
      filePath,
      '',
      '## 文件内容（节选）',
      '```',
      this.truncate(fileContent),
      '```',
      '',
      '## 本 discussion 的对话',
      threadText,
      '',
      `## 你的身份\n你是 ${maintainerName}。`,
      '',
      '请根据 Reviewer 的最新回复，判断下一步动作，并输出 JSON：',
      '{',
      '  "action": "fix" | "ask" | "ignore",',
      '  "reason": "简要说明理由",',
      '  "question": "如果 action=ask，填写向 Reviewer 提出的澄清问题",',
      '  "fixDescription": "如果 action=fix，可选的修复描述",',
      '  "deleteFile": "如果 action=fix 且需要从 MR 中移除某个文件，填 true"',
      '}',
    ].join('\n');
  }

  private truncate(content: string, maxLines = 80): string {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + '\n...（内容已截断）';
  }

  private parseDecisionFromToolCall(toolCall: { input: Record<string, unknown> }): MaintainerDecision {
    const input = toolCall.input as {
      action: string;
      reason?: string;
      question?: string;
      fixDescription?: string;
      deleteFile?: boolean;
    };

    const reason = input.reason ?? '未说明理由';
    switch (input.action) {
      case 'fix':
        return {
          action: 'fix',
          reason,
          fixDescription: input.fixDescription,
          deleteFile: input.deleteFile === true,
        };
      case 'ask':
        return {
          action: 'ask',
          reason,
          question: input.question ?? '能否补充一下期望的修改方式或范围？',
        };
      case 'ignore':
        return { action: 'ignore', reason };
      default:
        return {
          action: 'ask',
          reason: `未知 action: ${input.action}，需要 Reviewer 确认`,
          question: '我没有完全理解你的意思，能否再说得具体一些？',
        };
    }
  }
}
