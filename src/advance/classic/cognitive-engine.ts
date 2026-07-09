import type { LlmClient } from '../llm/client.js';
import type { RecallPlanner } from './memory/recall-planner.js';
import type { IMemoryClient } from './memory/types.js';
import type { WorktreeManager } from './worktree/worktree-manager.js';
import { buildFindingCaseKey } from './memory/finding-case-key.js';
import type {
  CognitiveContext,
  CognitiveDecision,
  CognitiveDepth,
} from './fix/cognitive-types.js';

export interface CognitiveEngineOptions {
  llmClient: LlmClient;
  recallPlanner?: RecallPlanner;
  memoryClient?: IMemoryClient;
  worktreeManager?: WorktreeManager;
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
  constructor(private readonly options: CognitiveEngineOptions) {}

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
    const prompt = [
      '请根据以下修复执行情况生成一句简短反思，用于后续同类问题参考。',
      '',
      '## 问题',
      `- 文件：${context.finding.file}:${context.finding.line}`,
      `- 描述：${context.finding.message}`,
      '',
      '## 执行方案',
      executedDescription,
      '',
      '## 结果',
      outcome,
      '',
      '请只输出一句反思，不要输出 JSON 或其他内容。',
    ].join('\n');

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
    const raw = await this.options.llmClient.complete(
      prompt,
      '你是谨慎的代码维护助手。请只输出 JSON。'
    );
    return this.parseDecision(raw, context);
  }

  private async decideStandard(context: CognitiveContext): Promise<CognitiveDecision> {
    const inquiry = await this.runInquiry(context);
    const enrichedContext = await this.enrichContext(context, inquiry);
    const options = await this.generateOptions(enrichedContext);
    return this.finalDecision(enrichedContext, options);
  }

  private async runInquiry(context: CognitiveContext): Promise<InquiryResult> {
    const overviewText = context.fileOverview
      ? `文件总行数：${context.fileOverview.lineCount}\n主要符号：\n${context.fileOverview.symbols
          .slice(0, 20)
          .map((s) => `- ${s.name} (${s.kind}) @ ${s.startLine}`)
          .join('\n')}`
      : '未提供文件概览';

    const prompt = [
      '请根据当前问题判断还需要补充哪些上下文信息。',
      '',
      '## 当前问题',
      `- 文件：${context.finding.file}:${context.finding.line}`,
      `- 描述：${context.finding.message}`,
      `- 建议：${context.finding.suggestion}`,
      '',
      '## 已掌握上下文',
      context.relatedFindings.length > 0
        ? `同 MR 其他 findings：\n${context.relatedFindings.map((f) => `- ${f.file}:${f.line} ${f.message}`).join('\n')}`
        : '无',
      context.recalledMemories.length > 0
        ? `已召回记忆：\n${context.recalledMemories.map((m) => `- ${m}`).join('\n')}`
        : '无',
      '',
      '## 文件概览',
      overviewText,
      '',
      '可查询的上下文类型：',
      '- file_history：某文件最近修改历史',
      '- reviewer_preference：某 Reviewer 对某类问题的偏好',
      '- project_knowledge：项目规范/架构约定',
      '- file_range：需要读取某文件指定行范围，target 格式为 "src/foo.ts:10-30"',
      '- file_search：需要在某文件搜索关键字，target 格式为 "src/foo.ts:keyword"',
      '',
      '请输出 JSON：',
      '{',
      '  "needsMoreContext": true|false,',
      '  "queries": [',
      '    { "type": "file_history", "target": "src/foo.ts" },',
      '    { "type": "file_range", "target": "src/foo.ts:10-30" },',
      '    { "type": "file_search", "target": "src/foo.ts:someKeyword" }',
      '  ],',
      '  "reason": "为什么需要这些补充"',
      '}',
    ].join('\n');

    const raw = await this.options.llmClient.complete(prompt, '你是上下文决策助手，只输出 JSON。');
    return this.parseInquiry(raw);
  }

  private async enrichContext(
    context: CognitiveContext,
    inquiry: InquiryResult
  ): Promise<CognitiveContext> {
    if (!inquiry.needsMoreContext || inquiry.queries.length === 0) {
      return context;
    }

    const extraMemories: string[] = [...context.recalledMemories];
    const extraFileContexts: string[] = context.extraFileContexts ? [...context.extraFileContexts] : [];

    for (const q of inquiry.queries) {
      if (q.type === 'project_knowledge' && this.options.recallPlanner) {
        const plan = await this.options.recallPlanner.plan({
          role: 'maintainer',
          taskType: 'fix',
          taskSummary: `${q.target} ${context.finding.message}`,
        });
        const memories = await this.options.recallPlanner.execute(plan);
        extraMemories.push(...memories);
      }
      if (q.type === 'reviewer_preference' && this.options.memoryClient) {
        const items = await this.options.memoryClient.recallUserPreferences(
          context.mrContext.iid.toString(),
          q.target
        );
        extraMemories.push(...items);
      }
      if (q.type === 'file_range' && this.options.worktreeManager) {
        const ctx = await this.readFileRangeContext(q.target);
        if (ctx) extraFileContexts.push(ctx);
      }
      if (q.type === 'file_search' && this.options.worktreeManager) {
        const ctx = await this.searchFileContext(q.target);
        if (ctx) extraFileContexts.push(ctx);
      }
      // file_history 由调用方在组装 CognitiveContext 时提供，或后续 Runner 补充
    }

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
      const lines = ranges.map((r) => `- ${filePath}:${r.startLine}-${r.endLine}`).join('\n');
      return `## ${filePath} 中 "${keyword}" 的匹配位置\n${lines}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[CognitiveEngine] 搜索文件 ${target} 失败: ${message}`);
      return null;
    }
  }

  private async generateOptions(context: CognitiveContext): Promise<OptionItem[]> {
    const overviewText = this.formatFileOverview(context.fileOverview);
    const extraContextsText = this.formatExtraFileContexts(context.extraFileContexts);

    const prompt = [
      '请根据以下上下文生成 2~3 个候选修复方案，并列出各自优缺点和风险。',
      '',
      '## 问题',
      `- 文件：${context.finding.file}:${context.finding.line}`,
      `- 描述：${context.finding.message}`,
      `- 建议：${context.finding.suggestion}`,
      '',
      '## 代码',
      '```',
      context.fileContent,
      '```',
      '',
      overviewText,
      extraContextsText,
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map((m) => `- ${m}`).join('\n')}`
        : '',
      '',
      '请输出 JSON：',
      '{',
      '  "options": [',
      '    {',
      '      "description": "方案描述",',
      '      "pros": ["优点1"],',
      '      "cons": ["缺点1"],',
      '      "risk": "low|medium|high"',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const raw = await this.options.llmClient.complete(prompt, '你是代码方案设计助手，只输出 JSON。');
    return this.parseOptions(raw);
  }

  private async finalDecision(
    context: CognitiveContext,
    options: OptionItem[]
  ): Promise<CognitiveDecision> {
    const overviewText = this.formatFileOverview(context.fileOverview);
    const extraContextsText = this.formatExtraFileContexts(context.extraFileContexts);

    const prompt = [
      '请从以下候选方案中选择最优方案，并输出最终决策。',
      '',
      '## 问题',
      `- 文件：${context.finding.file}:${context.finding.line}`,
      `- 描述：${context.finding.message}`,
      `- 建议：${context.finding.suggestion}`,
      '',
      '## 候选方案',
      options
        .map(
          (o, i) =>
            `${i + 1}. ${o.description}\n   优点：${o.pros.join('，')}\n   缺点：${o.cons.join('，')}\n   风险：${o.risk}`
        )
        .join('\n\n'),
      '',
      overviewText,
      extraContextsText,
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map((m) => `- ${m}`).join('\n')}`
        : '',
      '',
      '请输出 JSON：',
      '{',
      '  "action": "fix" | "ask" | "ignore",',
      '  "reason": "简要说明",',
      '  "question": "ask 时的问题",',
      '  "fixDescription": "fix 时的描述",',
      '  "deleteFile": true|false,',
      '  "scope": "trivial|local|cross-file",',
      '  "analysis": "问题分析",',
      '  "consideredOptions": ["方案1", "方案2"],',
      '  "reasoning": "选择最优方案的原因",',
      '  "confidence": "high|medium|low"',
      '}',
    ].join('\n');

    const raw = await this.options.llmClient.complete(prompt, '你是代码维护决策助手，只输出 JSON。');
    return this.parseDecision(raw, context);
  }

  private buildFastPrompt(context: CognitiveContext): string {
    const overviewText = this.formatFileOverview(context.fileOverview);
    const extraContextsText = this.formatExtraFileContexts(context.extraFileContexts);

    return [
      '## 文件路径',
      context.finding.file,
      '',
      overviewText,
      '## 相关代码',
      '```',
      context.fileContent,
      '```',
      '',
      extraContextsText,
      '## Reviewer 评论',
      context.originalComment,
      '',
      '## 解析出的 finding',
      `- 严重程度：${context.finding.severity}`,
      context.finding.ruleId ? `- 规则：${context.finding.ruleId}` : '',
      `- 行号：${context.finding.line}`,
      `- 问题描述：${context.finding.message}`,
      `- 修改建议：${context.finding.suggestion}`,
      '',
      context.recalledMemories.length > 0
        ? `## 相关记忆\n${context.recalledMemories.map((m) => `- ${m}`).join('\n')}`
        : '',
      '',
      '请输出 JSON：',
      '{',
      '  "action": "fix" | "ask" | "ignore",',
      '  "reason": "简要说明理由",',
      '  "question": "如果 action=ask，填写问题",',
      '  "fixDescription": "如果 action=fix，可选描述",',
      '  "deleteFile": "如果 action=fix 且需要删除文件，填 true",',
      '  "scope": "trivial|local|cross-file",',
      '  "analysis": "对问题的分析",',
      '  "consideredOptions": ["方案1", "方案2"],',
      '  "reasoning": "最终选择该方案的原因",',
      '  "confidence": "high|medium|low"',
      '}',
    ].join('\n');
  }

  private formatFileOverview(overview?: CognitiveContext['fileOverview']): string {
    if (!overview) return '';
    const symbols = overview.symbols
      .slice(0, 20)
      .map((s) => `- ${s.name} (${s.kind}) @ ${s.startLine}`)
      .join('\n');
    return `## 文件概览\n总行数：${overview.lineCount}\n主要符号：\n${symbols || '（未识别到顶层符号）'}\n\n`;
  }

  private formatExtraFileContexts(contexts?: CognitiveContext['extraFileContexts']): string {
    if (!contexts || contexts.length === 0) return '';
    return `## 补充上下文\n${contexts.join('\n\n')}\n\n`;
  }

  private parseDecision(raw: string, context: CognitiveContext): CognitiveDecision {
    const text = this.extractJson(raw);

    try {
      const parsed = JSON.parse(text) as {
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
      };

      const base = this.normalizeBaseDecision(parsed, context);
      return {
        ...base,
        analysis: parsed.analysis ?? '未提供分析',
        consideredOptions: Array.isArray(parsed.consideredOptions)
          ? parsed.consideredOptions
          : [],
        reasoning: parsed.reasoning ?? base.reason,
        confidence: this.normalizeConfidence(parsed.confidence),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[CognitiveEngine] 解析决策失败:', message, '原始响应:', raw);
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
    },
    _context: CognitiveContext
  ): {
    action: 'fix' | 'ask' | 'ignore';
    reason: string;
    question?: string;
    fixDescription?: string;
    deleteFile?: boolean;
    scope?: 'trivial' | 'local' | 'cross-file';
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
        return { action: 'ignore', reason };
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

  private parseInquiry(raw: string): InquiryResult {
    const text = this.extractJson(raw);
    try {
      const parsed = JSON.parse(text) as {
        needsMoreContext?: boolean;
        queries?: Array<{ type?: string; target?: string }>;
        reason?: string;
      };
      return {
        needsMoreContext: parsed.needsMoreContext === true,
        queries: (parsed.queries ?? [])
          .filter((q) => typeof q.type === 'string' && typeof q.target === 'string')
          .map((q) => ({ type: q.type as string, target: q.target as string })),
        reason: parsed.reason ?? '未说明',
      };
    } catch {
      return { needsMoreContext: false, queries: [], reason: '解析失败' };
    }
  }

  private parseOptions(raw: string): OptionItem[] {
    const text = this.extractJson(raw);
    try {
      const parsed = JSON.parse(text) as { options?: OptionItem[] };
      return (parsed.options ?? []).filter((o) => typeof o.description === 'string');
    } catch {
      return [];
    }
  }

  private extractJson(text: string): string {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return match ? match[1].trim() : text.trim();
  }
}
