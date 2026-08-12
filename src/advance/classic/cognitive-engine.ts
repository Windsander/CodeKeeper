import type { LlmClient } from '../llm/client.js';
import type { ToolDefinition } from '../llm/tool-types.js';
import type { RecallPlanner } from './memory/recall-planner.js';
import type { IMemoryClient } from './memory/types.js';
import type { WorktreeManager } from './worktree/worktree-manager.js';
import { buildFindingCaseKey } from './memory/finding-case-key.js';
import { logMemorySnapshot } from './utils/memory-snapshot.js';
import { defaultPromptLoader, type PromptLoader } from '../llm/prompts/loader.js';
import type { CognitiveContext, CognitiveDecision, CognitiveDepth } from './fix/cognitive-types.js';

const INQUIRY_DECISION_TOOL: ToolDefinition = {
  name: 'inquiry_decision',
  description: '判断是否需要补充上下文以及需要查询哪些上下文',
  input_schema: {
    type: 'object',
    properties: {
      needsMoreContext: { type: 'boolean' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            target: { type: 'string' },
          },
          required: ['type', 'target'],
          additionalProperties: false,
        },
      },
      reason: { type: 'string' },
    },
    required: ['needsMoreContext', 'queries', 'reason'],
    additionalProperties: false,
  },
};

const OPTIONS_DECISION_TOOL: ToolDefinition = {
  name: 'options_decision',
  description: '为问题生成 2~3 个候选修复方案',
  input_schema: {
    type: 'object',
    properties: {
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            pros: { type: 'array', items: { type: 'string' } },
            cons: { type: 'array', items: { type: 'string' } },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
          required: ['description', 'pros', 'cons', 'risk'],
          additionalProperties: false,
        },
      },
    },
    required: ['options'],
    additionalProperties: false,
  },
};

const FINAL_DECISION_TOOL: ToolDefinition = {
  name: 'final_decision',
  description:
    '从候选方案中选择最终修复决策。action 必须是 "fix"（你确信可以按建议修改代码）、"ask"（信息不足需要 Reviewer 澄清）或 "ignore"（无需修改）三者之一。',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['fix', 'ask', 'ignore'] },
      reason: { type: 'string' },
      question: { type: 'string' },
      fixDescription: { type: 'string' },
      deleteFile: { type: 'boolean' },
      scope: { type: 'string', enum: ['trivial', 'local', 'cross-file'] },
      analysis: { type: 'string' },
      consideredOptions: { type: 'array', items: { type: 'string' } },
      reasoning: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      alreadyFixed: { type: 'boolean' },
      replyBody: { type: 'string' },
    },
    required: ['action', 'reason'],
    additionalProperties: false,
  },
};

const ALREADY_FIXED_CHECK_TOOL: ToolDefinition = {
  name: 'already_fixed_check',
  description:
    '判断 finding 描述的问题在代码中是否已经被修复。如果提供的聚焦代码不足以判断，可设置 needsMoreContext=true 请求读取完整文件后再判。',
  input_schema: {
    type: 'object',
    properties: {
      alreadyFixed: { type: 'boolean' },
      reason: { type: 'string' },
      evidence: { type: 'string' },
      evidenceSnippet: {
        type: 'string',
        description:
          'alreadyFixed=true 时，从当前目标文件或已提供的额外文件上下文中原样摘录的最小代码片段',
      },
      evidenceLine: {
        type: 'number',
        description: 'evidenceSnippet 在对应文件中的起始行号；无法确定时可省略',
      },
      needsMoreContext: {
        type: 'boolean',
        description:
          '当聚焦代码窗口太窄、缺少必要上下文（如类型定义、跨函数引用）导致无法判断时设为 true',
      },
    },
    required: ['alreadyFixed', 'reason'],
    additionalProperties: false,
  },
};

function normalizeEvidenceFragment(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractPathReferences(text: string): string[] {
  return Array.from(
    text.matchAll(/[A-Za-z0-9_.@*~:-]+(?:[\\/][A-Za-z0-9_.@*~()-]+)+\.[A-Za-z0-9]+/g),
    match => match[0].replace(/\\/g, '/').toLowerCase()
  );
}

function extractDistinctiveCodeAnchors(text: string): string[] {
  const withoutPaths = text.replace(
    /[A-Za-z0-9_.@*~:-]+(?:[\\/][A-Za-z0-9_.@*~()-]+)+\.[A-Za-z0-9]+/g,
    ' '
  );
  return Array.from(
    withoutPaths.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g),
    match => match[0]
  ).filter(
    token =>
      token.includes('_') || /[a-z][A-Z]/.test(token) || (token.match(/[A-Z]/g)?.length ?? 0) >= 2
  );
}

/** already-fixed 证据必须能绑定到当前 finding 的文件或显式补充上下文。 */
export function isAlreadyFixedEvidenceGrounded(params: {
  findingFile: string;
  fileContent: string;
  extraFileContexts?: string[];
  evidence?: string;
  evidenceSnippet?: string;
}): boolean {
  const evidence = params.evidence?.trim() ?? '';
  const evidenceSnippet = params.evidenceSnippet?.trim() ?? '';
  if (!evidence && !evidenceSnippet) return false;

  const extraContexts = params.extraFileContexts ?? [];
  const corpus = [params.fileContent, ...extraContexts].join('\n');
  const normalizedCorpus = normalizeEvidenceFragment(corpus);
  const allowedPaths = new Set([
    params.findingFile.replace(/\\/g, '/').toLowerCase(),
    ...extraContexts.flatMap(extractPathReferences),
  ]);

  for (const path of extractPathReferences(`${evidence}\n${evidenceSnippet}`)) {
    if (
      !Array.from(allowedPaths).some(allowed => allowed.endsWith(path) || path.endsWith(allowed))
    ) {
      return false;
    }
  }

  if (evidenceSnippet && !normalizedCorpus.includes(normalizeEvidenceFragment(evidenceSnippet))) {
    return false;
  }

  const quotedAnchors = Array.from(evidence.matchAll(/`([^`\n]{2,160})`/g), match => match[1])
    .map(normalizeEvidenceFragment)
    .filter(anchor => /[a-z_$]/i.test(anchor) && !extractPathReferences(anchor).length);
  const distinctiveAnchors = extractDistinctiveCodeAnchors(evidence).map(normalizeEvidenceFragment);
  const codeAnchors = [...new Set([...quotedAnchors, ...distinctiveAnchors])];
  if (codeAnchors.some(anchor => !normalizedCorpus.includes(anchor))) {
    return false;
  }

  return true;
}

const FAST_DECISION_TOOL: ToolDefinition = {
  name: 'fast_decision',
  description:
    '快速判断对 finding 的下一步动作。action 必须是 "fix"、"ask" 或 "ignore" 之一，禁止返回其他值。',
  input_schema: FINAL_DECISION_TOOL.input_schema,
};

export interface CognitiveEngineOptions {
  llmClient: LlmClient;
  recallPlanner?: RecallPlanner;
  memoryClient?: IMemoryClient;
  worktreeManager?: WorktreeManager;
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

interface InquiryResult {
  needsMoreContext: boolean;
  queries: Array<{ type: string; target: string }>;
  reason: string;
}

interface OptionItem {
  description: string;
  pros: string[];
  cons: string[];
  risk: 'low' | 'medium' | 'high';
}

/**
 * 认知引擎
 *
 * 把 Maintainer 的决策过程拆成可配置的多步认知循环：
 * - fast：观察 → 决策（1 次 LLM 调用）
 * - standard：观察 → 追问 → 生成候选方案 → 决策（2~3 次调用）
 * - deep：standard 全部步骤 + 执行后反思并记录到记忆
 */
export class CognitiveEngine {
  private readonly promptLoader: PromptLoader;

  constructor(private readonly options: CognitiveEngineOptions) {
    this.promptLoader = options.promptLoader ?? defaultPromptLoader;
  }

  async decide(
    context: CognitiveContext,
    depth: CognitiveDepth = 'standard'
  ): Promise<CognitiveDecision> {
    if (depth === 'fast') {
      return this.decideFast(context);
    }
    // deep 模式在决策阶段与 standard 一致，反射由调用方在修复后触发
    return this.decideStandard(context);
  }

  /**
   * 根据修复执行结果生成反思，并关联到对应 finding case 记忆
   */
  async reflect(
    context: CognitiveContext,
    outcome: 'success' | 'failure',
    executedDescription: string
  ): Promise<string> {
    const prompt = this.promptLoader.load('cognitive-reflect-task', {
      findingFile: context.finding.file,
      findingLine: String(context.finding.line),
      findingMessage: context.finding.message,
      executedDescription,
      outcome,
    });

    const raw = await this.options.llmClient.complete(prompt);
    const reflection = raw.trim();

    if (this.options.memoryClient) {
      const key = buildFindingCaseKey({
        projectId: this.options.memoryClient.context.projectId,
        mrIid: context.mrContext.iid,
        file: context.finding.file,
        line: context.finding.line,
        ruleId: context.finding.ruleId,
      });
      await this.options.memoryClient.recordReflection({ caseKey: key, reflection, outcome });
    }

    return reflection;
  }

  private async decideFast(context: CognitiveContext): Promise<CognitiveDecision> {
    const prompt = this.buildFastPrompt(context);
    console.log(`[CognitiveEngine] decideFast prompt 长度=${prompt.length}`);
    const toolCall = await this.options.llmClient.completeDecision(
      [FAST_DECISION_TOOL],
      prompt,
      this.promptLoader.load('cognitive-fast-system')
    );
    console.log(`[CognitiveEngine] decideFast tool=${toolCall.name}`);
    logMemorySnapshot('CognitiveEngine.decideFast LLM 返回后');
    return this.parseDecision(toolCall.input, context);
  }

  private async decideStandard(context: CognitiveContext): Promise<CognitiveDecision> {
    logMemorySnapshot('CognitiveEngine.decideStandard 开始');
    const inquiry = await this.runInquiry(context);
    logMemorySnapshot('CognitiveEngine.decideStandard inquiry 后');
    const enrichedContext = await this.enrichContext(context, inquiry);
    logMemorySnapshot('CognitiveEngine.decideStandard enrichContext 后');

    // 显式预检：issue 是否已经被修复，避免对已修复问题生成无效修复方案
    const alreadyFixed = await this.checkAlreadyFixed(enrichedContext);
    if (alreadyFixed.alreadyFixed) {
      console.log(
        `[CognitiveEngine] 检测到问题已修复: ${enrichedContext.finding.file}:${enrichedContext.finding.line}`
      );
      return {
        action: 'ignore',
        reason: alreadyFixed.reason,
        alreadyFixed: true,
        replyBody: alreadyFixed.evidence || alreadyFixed.reason,
        analysis: alreadyFixed.reason,
        consideredOptions: [],
        reasoning: '当前代码已满足 Reviewer 的要求，无需修改',
        confidence: 'high',
      };
    }

    const options = await this.generateOptions(enrichedContext);
    logMemorySnapshot('CognitiveEngine.decideStandard generateOptions 后');
    const decision = await this.finalDecision(enrichedContext, options);
    logMemorySnapshot('CognitiveEngine.decideStandard finalDecision 后');
    return decision;
  }

  private async runInquiry(context: CognitiveContext): Promise<InquiryResult> {
    const overviewText = context.fileOverview
      ? `文件总行数：${context.fileOverview.lineCount}\n主要符号：\n${context.fileOverview.symbols
          .slice(0, 20)
          .map(s => `- ${s.name} (${s.kind}) @ ${s.startLine}`)
          .join('\n')}`
      : '未提供文件概览';

    const relatedFindings =
      context.relatedFindings.length > 0
        ? `同 MR 其他 findings：\n${context.relatedFindings.map(f => `- ${f.file}:${f.line} ${f.message}`).join('\n')}`
        : '无';

    const recalledMemories =
      context.recalledMemories.length > 0
        ? `已召回记忆：\n${context.recalledMemories.map(m => `- ${m}`).join('\n')}`
        : '无';

    const prompt = this.promptLoader.load('cognitive-inquiry-task', {
      findingFile: context.finding.file,
      findingLine: String(context.finding.line),
      findingMessage: context.finding.message,
      findingSuggestion: context.finding.suggestion ?? '',
      relatedFindings,
      recalledMemories,
      fileOverview: overviewText,
    });

    console.log(`[CognitiveEngine] runInquiry prompt 长度=${prompt.length}`);
    const toolCall = await this.options.llmClient.completeDecision(
      [INQUIRY_DECISION_TOOL],
      prompt,
      this.promptLoader.load('cognitive-inquiry-system')
    );
    console.log(`[CognitiveEngine] runInquiry tool=${toolCall.name}`);
    logMemorySnapshot('CognitiveEngine.runInquiry LLM 返回后');
    return this.parseInquiry(toolCall.input);
  }

  private async enrichContext(
    context: CognitiveContext,
    inquiry: InquiryResult
  ): Promise<CognitiveContext> {
    if (!inquiry.needsMoreContext || inquiry.queries.length === 0) {
      return context;
    }

    logMemorySnapshot('CognitiveEngine.enrichContext 开始');
    console.log(`[CognitiveEngine] enrichContext 查询数量=${inquiry.queries.length}`);

    const extraMemories: string[] = [...context.recalledMemories];
    const extraFileContexts: string[] = context.extraFileContexts
      ? [...context.extraFileContexts]
      : [];

    for (const q of inquiry.queries) {
      if (q.type === 'project_knowledge' && this.options.recallPlanner) {
        const plan = await this.options.recallPlanner.plan({
          role: 'maintainer',
          taskType: 'fix',
          taskSummary: `${q.target} ${context.finding.message}`,
        });
        const memories = await this.options.recallPlanner.execute(plan);
        console.log(
          `[CognitiveEngine] project_knowledge 召回结果数量=${memories.length}, 总字符=${memories.reduce((sum, m) => sum + m.length, 0)}`
        );
        extraMemories.push(...memories);
      }
      if (q.type === 'reviewer_preference' && this.options.memoryClient) {
        const items = await this.options.memoryClient.recallUserPreferences(
          context.mrContext.iid.toString(),
          q.target
        );
        console.log(
          `[CognitiveEngine] reviewer_preference 召回结果数量=${items.length}, 总字符=${items.reduce((sum, m) => sum + m.length, 0)}`
        );
        extraMemories.push(...items);
      }
      if (q.type === 'file_range' && this.options.worktreeManager) {
        const ctx = await this.readFileRangeContext(q.target);
        if (ctx) {
          console.log(`[CognitiveEngine] file_range 上下文长度=${ctx.length}`);
          extraFileContexts.push(ctx);
        }
      }
      if (q.type === 'file_search' && this.options.worktreeManager) {
        const ctx = await this.searchFileContext(q.target);
        if (ctx) {
          console.log(`[CognitiveEngine] file_search 上下文长度=${ctx.length}`);
          extraFileContexts.push(ctx);
        }
      }
      if (q.type === 'workspace_search' && this.options.worktreeManager) {
        const ctx = await this.searchWorkspaceContext(q.target);
        if (ctx) {
          console.log(`[CognitiveEngine] workspace_search 上下文长度=${ctx.length}`);
          extraFileContexts.push(ctx);
        }
      }
      // file_history 由调用方在组装 CognitiveContext 时提供，或后续 Runner 补充
    }

    logMemorySnapshot('CognitiveEngine.enrichContext 结束');
    return { ...context, recalledMemories: extraMemories, extraFileContexts };
  }

  private async readFileRangeContext(target: string): Promise<string | null> {
    const manager = this.options.worktreeManager;
    if (!manager) return null;

    const lastColon = target.lastIndexOf(':');
    if (lastColon === -1) return null;
    const filePath = target.slice(0, lastColon);
    const range = target.slice(lastColon + 1);
    const [startStr, endStr] = range.split('-');
    const startLine = parseInt(startStr, 10);
    const endLine = parseInt(endStr, 10);
    if (Number.isNaN(startLine) || Number.isNaN(endLine)) return null;

    try {
      const content = await manager.readFileRange(filePath, startLine, endLine);
      return `## ${filePath} 行 ${startLine}-${endLine}\n\`\`\`\n${content}\n\`\`\``;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CognitiveEngine] 读取文件范围 ${target} 失败: ${message}`);
      return null;
    }
  }

  private async searchFileContext(target: string): Promise<string | null> {
    const manager = this.options.worktreeManager;
    if (!manager) return null;

    const lastColon = target.lastIndexOf(':');
    if (lastColon === -1) return null;
    const filePath = target.slice(0, lastColon);
    const keyword = target.slice(lastColon + 1);
    if (!keyword) return null;

    try {
      const ranges = await manager.searchInFile(filePath, keyword);
      if (ranges.length === 0) return null;
      const lines = ranges.map(r => `- ${filePath}:${r.startLine}-${r.endLine}`).join('\n');
      return `## ${filePath} 中 "${keyword}" 的匹配位置\n${lines}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CognitiveEngine] 搜索文件 ${target} 失败: ${message}`);
      return null;
    }
  }

  private async searchWorkspaceContext(target: string): Promise<string | null> {
    const manager = this.options.worktreeManager;
    const keyword = target.trim();
    if (!manager || !keyword) return null;

    try {
      const matches = await manager.searchWorkspace(keyword);
      if (matches.length === 0) return null;
      const lines = matches
        .map(match => `- ${match.file}:${match.line} ${match.content}`)
        .join('\n');
      return `## 工作区中 ${keyword} 的匹配位置\n${lines}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CognitiveEngine] 搜索工作区 ${keyword} 失败: ${message}`);
      return null;
    }
  }

  /**
   * 显式检查 finding 描述的问题是否已经在当前代码中被修复
   */
  async checkAlreadyFixed(context: CognitiveContext): Promise<{
    alreadyFixed: boolean;
    reason: string;
    evidence?: string;
  }> {
    // 第一层：用聚焦上下文做轻量判断。prompt 短、噪音少，覆盖大多数情况。
    const focusedResult = await this.runAlreadyFixedCheck(context, context.fileContent, '聚焦窗口');
    if (focusedResult.alreadyFixed) {
      console.log(
        `[CognitiveEngine] 聚焦窗口判定问题已修复: ${context.finding.file}:${context.finding.line}`
      );
      return focusedResult;
    }
    if (!focusedResult.needsMoreContext && !context.staleFinding) {
      console.log(
        `[CognitiveEngine] 聚焦窗口判定问题未修复: ${context.finding.file}:${context.finding.line}, reason=${focusedResult.reason}`
      );
      return focusedResult;
    }

    // 第二层：聚焦窗口不够，或 finding 来自历史提交时，读完整文件再判一次。
    console.log(
      `[CognitiveEngine] 读取完整文件复核: ${context.finding.file}:${context.finding.line}, stale=${context.staleFinding === true}, reason=${focusedResult.reason}`
    );
    const fullContent = await this.loadFullFileContentForCheck(context);
    const fullResult = await this.runAlreadyFixedCheck(context, fullContent, '完整文件');
    console.log(
      `[CognitiveEngine] 完整文件复核结果: ${context.finding.file}:${context.finding.line}, alreadyFixed=${fullResult.alreadyFixed}, reason=${fullResult.reason}`
    );
    return fullResult;
  }

  /**
   * 执行一次 already_fixed_check 工具调用。
   */
  private async runAlreadyFixedCheck(
    context: CognitiveContext,
    fileContent: string,
    sourceLabel: string
  ): Promise<{
    alreadyFixed: boolean;
    reason: string;
    evidence?: string;
    needsMoreContext?: boolean;
  }> {
    const prompt = this.promptLoader.load('cognitive-already-fixed-task', {
      findingFile: context.finding.file,
      findingLine: String(context.finding.line),
      findingMessage: context.finding.message,
      findingSuggestion: context.finding.suggestion ?? '',
      fileContent,
      fileOverview: this.formatFileOverview(context.fileOverview),
      extraFileContexts: this.formatExtraFileContexts(context.extraFileContexts),
      staleWarning: context.staleFinding
        ? '注意：该 finding 来自落后于当前 MR HEAD 的历史评审提交。必须以当前完整文件为准，不得仅凭旧行号判断问题仍然存在。'
        : '',
    });

    try {
      const toolCall = await this.options.llmClient.completeDecision(
        [ALREADY_FIXED_CHECK_TOOL],
        prompt,
        this.promptLoader.load('cognitive-already-fixed-system')
      );
      const input = toolCall.input as {
        alreadyFixed?: boolean;
        reason?: string;
        evidence?: string;
        evidenceSnippet?: string;
        evidenceLine?: number;
        needsMoreContext?: boolean;
      };
      if (
        input.alreadyFixed === true &&
        !isAlreadyFixedEvidenceGrounded({
          findingFile: context.finding.file,
          fileContent,
          extraFileContexts: context.extraFileContexts,
          evidence: input.evidence,
          evidenceSnippet: input.evidenceSnippet,
        })
      ) {
        console.warn(
          `[CognitiveEngine] already_fixed_check (${sourceLabel}) 证据与目标 finding 不匹配: ${context.finding.file}:${context.finding.line}`
        );
        return {
          alreadyFixed: false,
          reason: 'already-fixed 证据无法绑定到当前 finding 的代码上下文，拒绝复用该结论',
          needsMoreContext: sourceLabel === '聚焦窗口',
        };
      }
      return {
        alreadyFixed: input.alreadyFixed === true,
        reason: input.reason ?? '未说明理由',
        evidence: input.evidence,
        needsMoreContext: input.needsMoreContext === true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CognitiveEngine] already_fixed_check (${sourceLabel}) 调用失败: ${message}`);
      return { alreadyFixed: false, reason: '无法判断问题是否已修复' };
    }
  }

  /**
   * 为 already_fixed_check 加载完整文件内容，避免聚焦窗口太窄导致误判。
   * 大文件超过阈值时回退到传入的聚焦内容。
   */
  private async loadFullFileContentForCheck(context: CognitiveContext): Promise<string> {
    const manager = this.options.worktreeManager;
    if (!manager) {
      return context.fileContent;
    }
    try {
      const resolved = await manager.resolveFilePath(context.finding.file);
      if (!resolved) {
        return context.fileContent;
      }
      const fullContent = await manager.readFile(resolved);
      if (typeof fullContent !== 'string' || fullContent.length > 100_000) {
        return context.fileContent;
      }
      return fullContent;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CognitiveEngine] 读取完整文件 ${context.finding.file} 失败: ${message}`);
      return context.fileContent;
    }
  }

  private async generateOptions(context: CognitiveContext): Promise<OptionItem[]> {
    const overviewText = this.formatFileOverview(context.fileOverview);
    const extraContextsText = this.formatExtraFileContexts(context.extraFileContexts);
    const relatedMemories =
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map(m => `- ${m}`).join('\n')}`
        : '';

    const prompt = this.promptLoader.load('cognitive-options-task', {
      findingFile: context.finding.file,
      findingLine: String(context.finding.line),
      findingMessage: context.finding.message,
      findingSuggestion: context.finding.suggestion ?? '',
      fileContent: context.fileContent,
      fileOverview: overviewText,
      extraFileContexts: extraContextsText,
      relatedMemories,
    });

    console.log(`[CognitiveEngine] generateOptions prompt 长度=${prompt.length}`);
    const toolCall = await this.options.llmClient.completeDecision(
      [OPTIONS_DECISION_TOOL],
      prompt,
      this.promptLoader.load('cognitive-options-system')
    );
    console.log(`[CognitiveEngine] generateOptions tool=${toolCall.name}`);
    logMemorySnapshot('CognitiveEngine.generateOptions LLM 返回后');
    return this.parseOptions(toolCall.input);
  }

  private async finalDecision(
    context: CognitiveContext,
    options: OptionItem[]
  ): Promise<CognitiveDecision> {
    const overviewText = this.formatFileOverview(context.fileOverview);
    const extraContextsText = this.formatExtraFileContexts(context.extraFileContexts);
    const relatedMemories =
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map(m => `- ${m}`).join('\n')}`
        : '';
    const optionsText = options
      .map(
        (o, i) =>
          `${i + 1}. ${o.description}\n   优点：${o.pros.join('，')}\n   缺点：${o.cons.join('，')}\n   风险：${o.risk}`
      )
      .join('\n\n');

    const prompt = this.promptLoader.load('cognitive-final-task', {
      findingFile: context.finding.file,
      findingLine: String(context.finding.line),
      findingMessage: context.finding.message,
      findingSuggestion: context.finding.suggestion ?? '',
      options: optionsText,
      fileContent: context.fileContent,
      fileOverview: overviewText,
      extraFileContexts: extraContextsText,
      relatedMemories,
    });

    console.log(`[CognitiveEngine] finalDecision prompt 长度=${prompt.length}`);
    const toolCall = await this.options.llmClient.completeDecision(
      [FINAL_DECISION_TOOL],
      prompt,
      this.promptLoader.load('cognitive-final-system')
    );
    console.log(`[CognitiveEngine] finalDecision tool=${toolCall.name}`);
    logMemorySnapshot('CognitiveEngine.finalDecision LLM 返回后');
    return this.parseDecision(toolCall.input, context);
  }

  private buildFastPrompt(context: CognitiveContext): string {
    const overviewText = this.formatFileOverview(context.fileOverview);
    const extraContextsText = this.formatExtraFileContexts(context.extraFileContexts);
    const relatedMemories =
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map(m => `- ${m}`).join('\n')}`
        : '';
    const findingRuleIdLine = context.finding.ruleId ? `- 规则：${context.finding.ruleId}` : '';

    return this.promptLoader.load('cognitive-fast-task', {
      findingFile: context.finding.file,
      findingSeverity: context.finding.severity,
      findingRuleIdLine,
      findingLine: String(context.finding.line),
      findingMessage: context.finding.message,
      findingSuggestion: context.finding.suggestion ?? '',
      fileOverview: overviewText,
      fileContent: context.fileContent,
      extraFileContexts: extraContextsText,
      originalComment: context.originalComment,
      relatedMemories,
    });
  }

  private formatFileOverview(overview?: CognitiveContext['fileOverview']): string {
    if (!overview) return '';
    const symbols = overview.symbols
      .slice(0, 20)
      .map(s => `- ${s.name} (${s.kind}) @ ${s.startLine}`)
      .join('\n');
    return `## 文件概览\n总行数：${overview.lineCount}\n主要符号：\n${symbols || '（未识别到顶层符号）'}\n\n`;
  }

  private formatExtraFileContexts(contexts?: CognitiveContext['extraFileContexts']): string {
    if (!contexts || contexts.length === 0) return '';
    return `## 补充上下文\n${contexts.join('\n\n')}\n\n`;
  }

  private parseDecision(
    input: Record<string, unknown>,
    context: CognitiveContext
  ): CognitiveDecision {
    try {
      const parsed = input as {
        action: string;
        reason?: string;
        question?: string;
        fixDescription?: string;
        deleteFile?: boolean;
        scope?: string;
        analysis?: string;
        consideredOptions?: string[];
        reasoning?: string;
        confidence?: string;
        alreadyFixed?: boolean;
        replyBody?: string;
      };

      const base = this.normalizeBaseDecision(parsed, context);
      // 如果模型明确标记问题已修复，强制按 ignore 处理，避免对已修复代码发起无效修复
      if (parsed.alreadyFixed === true && base.action === 'fix') {
        console.log(
          `[CognitiveEngine] 模型返回 alreadyFixed=true 但 action=fix，已归一化为 ignore: ${context.finding.file}:${context.finding.line}`
        );
        return {
          action: 'ignore',
          reason: base.reason,
          alreadyFixed: true,
          replyBody: parsed.replyBody || base.replyBody || '当前代码已满足 Reviewer 的要求',
          analysis: parsed.analysis ?? '问题已修复',
          consideredOptions: Array.isArray(parsed.consideredOptions)
            ? parsed.consideredOptions
            : [],
          reasoning: parsed.reasoning ?? base.reason,
          confidence: this.normalizeConfidence(parsed.confidence),
        };
      }
      return {
        ...base,
        analysis: parsed.analysis ?? '未提供分析',
        consideredOptions: Array.isArray(parsed.consideredOptions) ? parsed.consideredOptions : [],
        reasoning: parsed.reasoning ?? base.reason,
        confidence: this.normalizeConfidence(parsed.confidence),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CognitiveEngine] 解析决策失败:', message, '输入:', input);
      return {
        action: 'ask',
        reason: '无法解析 LLM 决策，需要 Reviewer 进一步说明',
        question: '我没有完全理解你的意思，能否再说得具体一些？',
        analysis: '决策解析失败',
        consideredOptions: [],
        reasoning: '决策解析失败，保守询问',
        confidence: 'low',
      };
    }
  }

  private normalizeBaseDecision(
    parsed: {
      action: string;
      reason?: string;
      question?: string;
      fixDescription?: string;
      deleteFile?: boolean;
      scope?: string;
      alreadyFixed?: boolean;
      replyBody?: string;
    },
    _context: CognitiveContext
  ): {
    action: 'fix' | 'ask' | 'ignore';
    reason: string;
    question?: string;
    fixDescription?: string;
    deleteFile?: boolean;
    scope?: 'trivial' | 'local' | 'cross-file';
    alreadyFixed?: boolean;
    replyBody?: string;
  } {
    const reason = parsed.reason ?? '未说明理由';
    switch (parsed.action) {
      case 'fix':
        return {
          action: 'fix',
          reason,
          fixDescription: parsed.fixDescription,
          deleteFile: parsed.deleteFile === true,
          scope: this.normalizeScope(parsed.scope),
        };
      case 'ask':
        return {
          action: 'ask',
          reason,
          question: parsed.question ?? '能否补充一下期望的修改方式或范围？',
        };
      case 'ignore':
        return {
          action: 'ignore',
          reason,
          alreadyFixed: parsed.alreadyFixed === true,
          replyBody: parsed.replyBody,
        };
      default:
        return {
          action: 'ask',
          reason: `未知的 action: ${parsed.action}，需要 Reviewer 确认`,
          question: '我没有完全理解你的意思，能否再说得具体一些？',
        };
    }
  }

  private normalizeScope(scope?: string): 'trivial' | 'local' | 'cross-file' {
    if (scope === 'trivial' || scope === 'cross-file') return scope;
    return 'local';
  }

  private normalizeConfidence(confidence?: string): 'high' | 'medium' | 'low' {
    if (confidence === 'high' || confidence === 'low') return confidence;
    return 'medium';
  }

  private parseInquiry(input: Record<string, unknown>): InquiryResult {
    try {
      const parsed = input as {
        needsMoreContext?: boolean;
        queries?: Array<{ type?: string; target?: string }>;
        reason?: string;
      };
      return {
        needsMoreContext: parsed.needsMoreContext === true,
        queries: (parsed.queries ?? [])
          .filter(q => typeof q.type === 'string' && typeof q.target === 'string')
          .map(q => ({ type: q.type as string, target: q.target as string })),
        reason: parsed.reason ?? '未说明',
      };
    } catch {
      return { needsMoreContext: false, queries: [], reason: '解析失败' };
    }
  }

  private parseOptions(input: Record<string, unknown>): OptionItem[] {
    try {
      const parsed = input as { options?: OptionItem[] };
      return (parsed.options ?? []).filter(o => typeof o.description === 'string');
    } catch {
      return [];
    }
  }
}
