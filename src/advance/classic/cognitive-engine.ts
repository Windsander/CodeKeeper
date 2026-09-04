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
            affectedFiles: { type: 'array', items: { type: 'string' } },
            verificationSteps: { type: 'array', items: { type: 'string' } },
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
      notActionable: { type: 'boolean' },
      replyBody: { type: 'string' },
      affectedFiles: { type: 'array', items: { type: 'string' } },
      verificationPlan: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      adversarialResponses: { type: 'array', items: { type: 'string' } },
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
      notActionable: {
        type: 'boolean',
        description: '问题是误报、重复项或按项目约定无需代码修改时设为 true',
      },
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
  /** 可选的轻量判别器，作为 already-fixed 与方案红队的辅助信号 */
  localJudge?: import('./fix/maintainer-local-judge.js').MaintainerLocalJudge;
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

interface InquiryResult {
  needsMoreContext: boolean;
  queries: Array<{ type: string; target: string }>;
  reason: string;
  status?: 'actionable' | 'needs-context' | 'already-fixed' | 'not-actionable';
}

interface OptionItem {
  description: string;
  pros: string[];
  cons: string[];
  risk: 'low' | 'medium' | 'high';
  affectedFiles?: string[];
  verificationSteps?: string[];
}

interface AdversarialReview {
  approve: boolean;
  concerns: string[];
  requiredChanges: string[];
  reason: string;
}

interface AdversarialReviewAttempt {
  status: 'skipped' | 'reviewed' | 'failed';
  review?: AdversarialReview;
  reason?: string;
}

interface AlreadyFixedCheckResult {
  alreadyFixed: boolean;
  notActionable?: boolean;
  reason: string;
  evidence?: string;
  needsMoreContext?: boolean;
}

/**
 * 认知引擎
 *
 * 把 Maintainer 的决策过程拆成可配置的多步认知循环：
 * - fast：观察 → already-fixed 前置复查 → 决策（至少 2 次 LLM 调用）
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
    return this.decideStandard(context, depth);
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
    const alreadyFixed = await this.checkAlreadyFixed(context);
    if (alreadyFixed.alreadyFixed || alreadyFixed.notActionable) {
      return this.buildAlreadyFixedDecision(alreadyFixed);
    }

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

  private async decideStandard(
    context: CognitiveContext,
    depth: CognitiveDepth
  ): Promise<CognitiveDecision> {
    logMemorySnapshot('CognitiveEngine.decideStandard 开始');
    const initialAlreadyFixed = await this.checkAlreadyFixed(context);
    if (initialAlreadyFixed.alreadyFixed || initialAlreadyFixed.notActionable) {
      return this.buildAlreadyFixedDecision(initialAlreadyFixed);
    }

    const inquiry = await this.runInquiry(context, initialAlreadyFixed);
    logMemorySnapshot('CognitiveEngine.decideStandard inquiry 后');
    const enrichedContext = await this.enrichContext(context, inquiry);
    logMemorySnapshot('CognitiveEngine.decideStandard enrichContext 后');

    const alreadyFixed = this.hasAdditionalContext(context, enrichedContext)
      ? await this.checkAlreadyFixed(enrichedContext)
      : initialAlreadyFixed;
    if (alreadyFixed.alreadyFixed || alreadyFixed.notActionable) {
      return this.buildAlreadyFixedDecision(alreadyFixed);
    }

    const options = await this.generateOptions(enrichedContext);
    logMemorySnapshot('CognitiveEngine.decideStandard generateOptions 后');
    const adversarial = await this.reviewOptions(
      enrichedContext,
      options,
      depth === 'deep' ? 2 : 1
    );
    let decision = await this.finalDecision(enrichedContext, options, adversarial);
    const decisionReviews: AdversarialReview[] = [];
    if (decision.action === 'fix') {
      const firstDecisionReviewAttempt = await this.reviewFinalDecision(
        enrichedContext,
        options,
        adversarial,
        decision
      );
      if (firstDecisionReviewAttempt.status === 'failed') {
        return this.buildAdversarialAskDecision(
          [
            adversarial,
            this.buildAdversarialReviewFailure(
              firstDecisionReviewAttempt.reason ?? '最终决策独立红队复核失败'
            ),
          ],
          options,
          decision,
          '最终修复决策未能完成可靠的独立红队复核'
        );
      }
      const firstDecisionReview = firstDecisionReviewAttempt.review;
      if (firstDecisionReview) {
        decisionReviews.push(firstDecisionReview);
      }

      if (firstDecisionReview && !firstDecisionReview.approve) {
        try {
          decision = await this.finalDecision(
            enrichedContext,
            options,
            adversarial,
            this.buildAdversarialDecisionFollowUp(firstDecisionReview, decision)
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[CognitiveEngine] 红队修订轮调用失败，转为澄清: ${message}`);
          return this.buildAdversarialAskDecision(
            [adversarial, ...decisionReviews],
            options,
            decision,
            '最终修复决策未能完成红队要求的修订'
          );
        }

        if (decision.action === 'fix') {
          const revisedDecisionReviewAttempt = await this.reviewFinalDecision(
            enrichedContext,
            options,
            adversarial,
            decision,
            decisionReviews
          );
          const revisedDecisionReview = revisedDecisionReviewAttempt.review;
          if (revisedDecisionReview) {
            decisionReviews.push(revisedDecisionReview);
          }
          if (!revisedDecisionReview || !revisedDecisionReview.approve) {
            const reviewFailure = revisedDecisionReview
              ? []
              : [
                  this.buildAdversarialReviewFailure(
                    revisedDecisionReviewAttempt.reason ?? '最终决策修订后未能完成独立红队复核'
                  ),
                ];
            return this.buildAdversarialAskDecision(
              [adversarial, ...decisionReviews, ...reviewFailure],
              options,
              decision,
              revisedDecisionReview
                ? '最终修复决策经过一次修订后仍未通过独立红队复核'
                : '最终修复决策修订后未能完成独立红队复核'
            );
          }
        }
      }
    }
    logMemorySnapshot('CognitiveEngine.decideStandard finalDecision 后');

    const verificationPlan = this.normalizeStringList(
      decision.verificationPlan?.length
        ? decision.verificationPlan
        : options.flatMap(option => option.verificationSteps ?? [])
    ).slice(0, 8);
    const adversarialReviews = [adversarial, ...decisionReviews];
    const adversarialConcerns = this.collectAdversarialConcerns(adversarialReviews).slice(0, 30);
    const risks = this.normalizeStringList([
      ...(decision.risks ?? []),
      ...options.flatMap(option =>
        option.risk === 'high' ? [`高风险方案：${option.description}`] : []
      ),
      ...adversarialConcerns,
    ]).slice(0, 20);
    return {
      ...decision,
      adversarialConcerns,
      adversarialResponses: this.normalizeStringList(decision.adversarialResponses).slice(0, 30),
      risks,
      verificationPlan,
      affectedFiles: this.normalizeStringList(
        decision.affectedFiles?.length
          ? decision.affectedFiles
          : Array.from(new Set(options.flatMap(option => option.affectedFiles ?? [])))
      ).slice(0, 20),
      analysis: decision.analysis || '已完成问题状态、方案与风险审查',
    };
  }

  private async runInquiry(
    context: CognitiveContext,
    alreadyFixedAssessment?: AlreadyFixedCheckResult
  ): Promise<InquiryResult> {
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
      alreadyFixedAssessment: alreadyFixedAssessment
        ? `前置复查结论：问题尚未被确认已修复。理由：${alreadyFixedAssessment.reason}`
        : '未执行前置复查',
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
  async checkAlreadyFixed(context: CognitiveContext): Promise<AlreadyFixedCheckResult> {
    // 第一层：用聚焦上下文做轻量判断。prompt 短、噪音少，覆盖大多数情况。
    const focusedResult = await this.runAlreadyFixedCheck(context, context.fileContent, '聚焦窗口');
    if (focusedResult.alreadyFixed || focusedResult.notActionable) {
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
  ): Promise<AlreadyFixedCheckResult> {
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
        notActionable?: boolean;
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
          notActionable: false,
          reason: 'already-fixed 证据无法绑定到当前 finding 的代码上下文，拒绝复用该结论',
          needsMoreContext: sourceLabel === '聚焦窗口',
        };
      }
      return {
        alreadyFixed: input.alreadyFixed === true,
        notActionable: input.notActionable === true,
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
    options: OptionItem[],
    adversarial: AdversarialReview,
    followUpInstruction = ''
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
          `${i + 1}. ${o.description}\n   优点：${o.pros.join('，')}\n   缺点：${o.cons.join('，')}\n   风险：${o.risk}\n   可能受影响文件：${o.affectedFiles?.join('，') || '未说明'}\n   验证步骤：${o.verificationSteps?.join('；') || '未说明'}`
      )
      .join('\n\n');
    const adversarialReview = [
      `是否通过：${adversarial.approve ? '是' : '否/需修订'}`,
      `理由：${adversarial.reason || '未说明'}`,
      `关键疑虑：${adversarial.concerns.join('；') || '无'}`,
      `必须改变：${adversarial.requiredChanges.join('；') || '无'}`,
    ].join('\n');

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
      adversarialReview,
      adversarialFollowUp: followUpInstruction,
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
        notActionable?: boolean;
        replyBody?: string;
        affectedFiles?: unknown;
        verificationPlan?: unknown;
        risks?: unknown;
        adversarialConcerns?: unknown;
        adversarialResponses?: unknown;
      };

      const base = this.normalizeBaseDecision(parsed, context);
      // 如果模型明确标记问题已修复或无需处理，强制按 ignore 处理，避免无效修改
      if (
        (parsed.alreadyFixed === true || parsed.notActionable === true) &&
        base.action === 'fix'
      ) {
        console.log(
          `[CognitiveEngine] 模型返回无需修改标记但 action=fix，已归一化为 ignore: ${context.finding.file}:${context.finding.line}`
        );
        return {
          action: 'ignore',
          reason: base.reason,
          alreadyFixed: parsed.alreadyFixed === true,
          notActionable: parsed.notActionable === true,
          replyBody:
            parsed.replyBody ||
            base.replyBody ||
            (parsed.alreadyFixed === true
              ? '当前代码已满足 Reviewer 的要求'
              : '当前 finding 无需修改'),
          analysis:
            parsed.analysis ?? (parsed.alreadyFixed === true ? '问题已修复' : '问题无需处理'),
          consideredOptions: Array.isArray(parsed.consideredOptions)
            ? parsed.consideredOptions
            : [],
          reasoning: parsed.reasoning ?? base.reason,
          confidence: this.normalizeConfidence(parsed.confidence),
          affectedFiles: this.normalizeStringList(parsed.affectedFiles),
          verificationPlan: this.normalizeStringList(parsed.verificationPlan),
          risks: this.normalizeStringList(parsed.risks),
          adversarialConcerns: this.normalizeStringList(parsed.adversarialConcerns),
          adversarialResponses: this.normalizeStringList(parsed.adversarialResponses),
        };
      }
      return {
        ...base,
        analysis: parsed.analysis ?? '未提供分析',
        consideredOptions: Array.isArray(parsed.consideredOptions) ? parsed.consideredOptions : [],
        reasoning: parsed.reasoning ?? base.reason,
        confidence: this.normalizeConfidence(parsed.confidence),
        affectedFiles: this.normalizeStringList(parsed.affectedFiles),
        verificationPlan: this.normalizeStringList(parsed.verificationPlan),
        risks: this.normalizeStringList(parsed.risks),
        adversarialConcerns: this.normalizeStringList(parsed.adversarialConcerns),
        adversarialResponses: this.normalizeStringList(parsed.adversarialResponses),
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
      notActionable?: boolean;
      replyBody?: string;
      affectedFiles?: unknown;
      verificationPlan?: unknown;
      risks?: unknown;
      adversarialConcerns?: unknown;
      adversarialResponses?: unknown;
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
    notActionable?: boolean;
    replyBody?: string;
    affectedFiles?: string[];
    verificationPlan?: string[];
    risks?: string[];
    adversarialConcerns?: string[];
    adversarialResponses?: string[];
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
          alreadyFixed: parsed.alreadyFixed === true,
          notActionable: parsed.notActionable === true,
          affectedFiles: this.normalizeStringList(parsed.affectedFiles),
          verificationPlan: this.normalizeStringList(parsed.verificationPlan),
          risks: this.normalizeStringList(parsed.risks),
          adversarialConcerns: this.normalizeStringList(parsed.adversarialConcerns),
          adversarialResponses: this.normalizeStringList(parsed.adversarialResponses),
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
          notActionable: parsed.notActionable === true,
          replyBody: parsed.replyBody,
          affectedFiles: this.normalizeStringList(parsed.affectedFiles),
          verificationPlan: this.normalizeStringList(parsed.verificationPlan),
          risks: this.normalizeStringList(parsed.risks),
          adversarialConcerns: this.normalizeStringList(parsed.adversarialConcerns),
          adversarialResponses: this.normalizeStringList(parsed.adversarialResponses),
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

  private normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean)
      )
    );
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
      const parsed = input as { options?: unknown };
      if (!Array.isArray(parsed.options)) return [];
      return parsed.options
        .filter((option): option is Record<string, unknown> => {
          return Boolean(option) && typeof option === 'object' && !Array.isArray(option);
        })
        .map(option => ({
          description: typeof option.description === 'string' ? option.description.trim() : '',
          pros: this.normalizeStringList(option.pros),
          cons: this.normalizeStringList(option.cons),
          risk: ((): OptionItem['risk'] => {
            const risk = option.risk;
            if (risk === 'high' || risk === 'medium' || risk === 'low') return risk;
            return 'medium';
          })(),
          affectedFiles: this.normalizeStringList(option.affectedFiles),
          verificationSteps: this.normalizeStringList(option.verificationSteps),
        }))
        .filter(option => option.description.length > 0);
    } catch {
      return [];
    }
  }

  private buildAlreadyFixedDecision(result: {
    alreadyFixed: boolean;
    notActionable?: boolean;
    reason: string;
    evidence?: string;
  }): CognitiveDecision {
    const alreadyFixed = result.alreadyFixed === true;
    const notActionable = result.notActionable === true;
    return {
      action: 'ignore',
      reason: result.reason,
      alreadyFixed,
      notActionable,
      replyBody: result.evidence || result.reason,
      analysis: alreadyFixed ? '问题已在当前代码中修复' : '该 finding 当前不需要代码修改',
      consideredOptions: [],
      reasoning: alreadyFixed
        ? '当前代码已经满足 Reviewer 所指出的问题，无需重复修改'
        : '当前 finding 不需要代码修改，避免为误报或无需处理的问题引入变更',
      confidence: 'high',
      risks: notActionable ? ['未执行代码修改；如 Reviewer 仍认为需要处理，应补充可执行证据'] : [],
    };
  }

  private hasAdditionalContext(base: CognitiveContext, enriched: CognitiveContext): boolean {
    return (
      enriched.recalledMemories.length > base.recalledMemories.length ||
      (enriched.extraFileContexts?.length ?? 0) > (base.extraFileContexts?.length ?? 0)
    );
  }

  private getAdversarialItems(adversarial: AdversarialReview): string[] {
    const concerns = this.normalizeStringList([
      ...adversarial.concerns,
      ...adversarial.requiredChanges,
    ]);
    if (concerns.length > 0) return concerns;
    return adversarial.approve ? [] : this.normalizeStringList([adversarial.reason]);
  }

  private collectAdversarialConcerns(reviews: AdversarialReview[]): string[] {
    return this.normalizeStringList(
      reviews.flatMap(review => [
        ...review.concerns,
        ...review.requiredChanges,
        review.approve ? '' : review.reason,
      ])
    );
  }

  private buildAdversarialReviewFailure(reason: string): AdversarialReview {
    return {
      approve: false,
      concerns: [],
      requiredChanges: ['在执行修复前重新完成独立红队复核'],
      reason: `独立红队复核未能可靠完成：${reason}`,
    };
  }

  private buildAdversarialDecisionFollowUp(
    adversarial: AdversarialReview,
    decision: CognitiveDecision
  ): string {
    const concerns = this.getAdversarialItems(adversarial);
    return [
      '上一版最终决策未通过独立红队复核。请重新审视并形成新的最终决策，而不是沿用原结论。',
      `上一版理由：${decision.reason}`,
      decision.adversarialResponses?.length
        ? `上一版主决策回应：\n- ${decision.adversarialResponses.join('\n- ')}`
        : '上一版没有给出可审计的红队回应。',
      concerns.length > 0
        ? `必须逐项回应以下意见：\n- ${concerns.join('\n- ')}`
        : '红队未批准该方案，请明确说明阻断风险及其处理方式。',
      '如果仍无法证明根因、影响范围和验证标准已经闭环，应选择 ask；如果坚持 fix，必须在 adversarialResponses 中逐项说明处理方式，并给出 verificationPlan。',
    ].join('\n\n');
  }

  private buildAdversarialAskDecision(
    reviews: AdversarialReview[],
    options: OptionItem[],
    decision?: CognitiveDecision,
    reason = '最终修复决策仍有未闭环的关键风险'
  ): CognitiveDecision {
    const concerns = this.collectAdversarialConcerns(reviews);
    return {
      action: 'ask',
      reason,
      question: `红队评审指出以下风险，当前还不能安全自动修复：${concerns.join('；') || reason}。请补充约束、确认处理方向，或在独立复核恢复后重试。`,
      analysis:
        '方案与最终决策的独立复核未形成可批准结论，关键风险仍未被当前代码证据与验证计划闭环',
      consideredOptions: options.map(option => option.description),
      reasoning: '当前流程未能形成经独立复核确认的风险闭环，因此不能直接进入代码修改',
      confidence: 'low',
      risks: concerns,
      adversarialConcerns: concerns,
      adversarialResponses: this.normalizeStringList(decision?.adversarialResponses),
    };
  }

  private formatCandidateOptions(options: OptionItem[]): string {
    return options
      .map(
        (option, index) =>
          `${index + 1}. ${option.description}\n优点：${option.pros.join('，') || '无'}\n缺点：${option.cons.join('，') || '无'}\n风险：${option.risk}\n可能受影响文件：${option.affectedFiles?.join('，') || '未说明'}\n验证步骤：${option.verificationSteps?.join('；') || '未说明'}`
      )
      .join('\n\n');
  }

  private formatAdversarialReview(review: AdversarialReview): string {
    return [
      `是否通过：${review.approve ? '是' : '否/需修订'}`,
      `理由：${review.reason || '未说明'}`,
      `关键疑虑：${review.concerns.join('；') || '无'}`,
      `必须改变：${review.requiredChanges.join('；') || '无'}`,
    ].join('\n');
  }

  private buildAdversarialCodeHint(context: CognitiveContext): string {
    return [context.fileContent, this.formatExtraFileContexts(context.extraFileContexts)]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 30_000);
  }

  private async reviewFinalDecision(
    context: CognitiveContext,
    options: OptionItem[],
    optionReview: AdversarialReview,
    decision: CognitiveDecision,
    priorDecisionReviews: AdversarialReview[] = []
  ): Promise<AdversarialReviewAttempt> {
    const judge = this.options.localJudge;
    if (!judge || typeof judge.adversarialDecisionReview !== 'function') {
      return { status: 'skipped' };
    }
    if (!judge.isAvailable()) {
      return { status: 'failed', reason: '最终决策红队服务当前不可用' };
    }

    const reviewHistory = [
      `方案红队评审：\n${this.formatAdversarialReview(optionReview)}`,
      ...priorDecisionReviews.map(
        (review, index) =>
          `第 ${index + 1} 轮最终决策红队复核：\n${this.formatAdversarialReview(review)}`
      ),
    ].join('\n\n');
    const finalDecision = JSON.stringify(
      {
        action: decision.action,
        reason: decision.reason,
        fixDescription: decision.fixDescription,
        scope: decision.scope,
        analysis: decision.analysis,
        reasoning: decision.reasoning,
        affectedFiles: decision.affectedFiles,
        verificationPlan: decision.verificationPlan,
        risks: decision.risks,
        adversarialResponses: decision.adversarialResponses,
      },
      null,
      2
    );

    try {
      const result = await judge.adversarialDecisionReview(
        `${context.finding.file}:${context.finding.line}\n${context.finding.message}\n${context.finding.suggestion ?? ''}`,
        `${this.formatCandidateOptions(options)}\n\n${reviewHistory}`,
        finalDecision,
        this.buildAdversarialCodeHint(context)
      );
      if ('kind' in result && result.kind === 'reliable') {
        return {
          status: 'reviewed',
          review: {
            approve: result.approve,
            concerns: this.normalizeStringList(result.concerns),
            requiredChanges: this.normalizeStringList(result.requiredChanges),
            reason: result.reason || '最终决策红队复核完成',
          },
        };
      }
      console.warn(`[CognitiveEngine] 最终决策红队复核不可用: ${result.reason}`);
      return { status: 'failed', reason: result.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CognitiveEngine] 最终决策红队复核失败: ${message}`);
      return { status: 'failed', reason: message };
    }
  }

  private async reviewOptions(
    context: CognitiveContext,
    options: OptionItem[],
    rounds: number
  ): Promise<AdversarialReview> {
    const judge = this.options.localJudge;
    if (!judge || typeof judge.adversarialReview !== 'function' || !judge.isAvailable()) {
      return {
        approve: true,
        concerns: [],
        requiredChanges: [],
        reason: '方案红队辅助不可用，由最终决策模型直接结合方案与代码判断',
      };
    }

    const candidateOptions = this.formatCandidateOptions(options);
    const codeHint = this.buildAdversarialCodeHint(context);

    let previousConcerns: string[] = [];
    const reviews: AdversarialReview[] = [];
    for (let round = 0; round < rounds; round++) {
      const prior = previousConcerns.length
        ? `\n\n上一轮红队意见（请从不同角度继续检查，不要机械重复）：\n${previousConcerns.map(item => `- ${item}`).join('\n')}`
        : '';
      try {
        const result = await judge.adversarialReview(
          `${context.finding.file}:${context.finding.line}\n${context.finding.message}\n${context.finding.suggestion ?? ''}${prior}`,
          candidateOptions,
          codeHint
        );
        if ('kind' in result && result.kind === 'reliable') {
          const review: AdversarialReview = {
            approve: result.approve,
            concerns: this.normalizeStringList(result.concerns),
            requiredChanges: this.normalizeStringList(result.requiredChanges),
            reason: result.reason || '红队评审完成',
          };
          reviews.push(review);
          previousConcerns = this.collectAdversarialConcerns(reviews);
        } else {
          console.warn(`[CognitiveEngine] 第 ${round + 1} 轮方案红队评审不可用: ${result.reason}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[CognitiveEngine] 第 ${round + 1} 轮方案红队评审失败: ${message}`);
      }
    }
    if (reviews.length === 0) {
      return {
        approve: true,
        concerns: [],
        requiredChanges: [],
        reason: '方案红队辅助未返回可靠结果，由最终决策模型结合代码判断',
      };
    }
    return {
      approve: reviews.every(review => review.approve),
      concerns: this.normalizeStringList(reviews.flatMap(review => review.concerns)),
      requiredChanges: this.normalizeStringList(reviews.flatMap(review => review.requiredChanges)),
      reason: this.normalizeStringList(reviews.map(review => review.reason)).join('；'),
    };
  }
}
