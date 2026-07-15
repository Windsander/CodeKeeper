import { logger } from '../../../core/logger.js';
import type { LlmClient } from '../../llm/client.js';
import type { ToolDefinition } from '../../llm/tool-types.js';
import type { IMemoryClient } from './types.js';
import { logMemorySnapshot } from '../utils/memory-snapshot.js';
import { defaultPromptLoader, type PromptLoader } from '../../llm/prompts/loader.js';
const RECALL_DECISION_TOOL: ToolDefinition = {
  name: 'recall_decision',
  description: '判断当前任务是否需要查询历史记忆，以及需要查询哪些类型',
  input_schema: {
    type: 'object',
    properties: {
      needsRecall: { type: 'boolean' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            query: { type: 'string' },
            userId: { type: 'string' },
          },
          required: ['type', 'query'],
          additionalProperties: true,
        },
      },
      reason: { type: 'string' },
    },
    required: ['needsRecall', 'queries', 'reason'],
    additionalProperties: false,
  },
};

/**
 * 可召回的记忆类型
 */
export type RecallType = 'review' | 'maintenance' | 'project_knowledge' | 'user_preferences';

/**
 * 单条召回查询
 */
export interface RecallQuery {
  /** 记忆类型 */
  type: RecallType;
  /** 召回 query */
  query: string;
  /** 仅 user_preferences 需要 */
  userId?: string;
}

/**
 * 召回计划
 */
export interface RecallPlan {
  /** 是否需要召回 */
  needsRecall: boolean;
  /** 具体查询列表 */
  queries: RecallQuery[];
  /** 决策理由 */
  reason: string;
}

/**
 * 召回规划器构造选项
 */
export interface RecallPlannerOptions {
  /** LLM 客户端 */
  llmClient: LlmClient;
  /** 记忆客户端 */
  memoryClient: IMemoryClient;
  /** 可用的 recall 类型白名单，默认全开 */
  enabledTypes?: RecallType[];
  /** 自定义决策提示词（覆盖默认） */
  decisionPrompt?: string;
  /** 可选的 prompt 加载器，默认使用全局 loader */
  promptLoader?: PromptLoader;
}

/**
 * 决策输入
 */
export interface RecallDecisionInput {
  /** 当前角色，如 reviewer / maintainer / archiver */
  role: string;
  /** 当前任务类型，如 review / reply / fix */
  taskType: string;
  /** 当前任务摘要，用于判断需要查什么 */
  taskSummary: string;
  /** 可选：当前可用的 findings 文本 */
  availableFindings?: string;
}

const ALL_RECALL_TYPES: RecallType[] = [
  'review',
  'maintenance',
  'project_knowledge',
  'user_preferences',
];

/**
 * 记忆查询规划器
 *
 * 让 Agent 自己决定是否需要查询记忆、查询哪类记忆、query 是什么。
 * 执行时按需调用 memoryClient 的对应 recall 方法，而不是一次性全查。
 */
export class RecallPlanner {
  private readonly llmClient: LlmClient;
  private readonly memoryClient: IMemoryClient;
  private readonly enabledTypes: Set<RecallType>;
  private readonly customDecisionPrompt?: string;
  private readonly promptLoader: PromptLoader;

  constructor(options: RecallPlannerOptions) {
    this.llmClient = options.llmClient;
    this.memoryClient = options.memoryClient;
    this.enabledTypes = new Set(options.enabledTypes ?? ALL_RECALL_TYPES);
    this.customDecisionPrompt = options.decisionPrompt;
    this.promptLoader = options.promptLoader ?? defaultPromptLoader;
  }

  /**
   * 根据任务上下文生成召回计划
   */
  async plan(input: RecallDecisionInput): Promise<RecallPlan> {
    const prompt = this.buildPrompt(input);
    try {
      const toolCall = await this.llmClient.completeDecision(
        [RECALL_DECISION_TOOL],
        prompt,
        '你是记忆查询决策助手，必须从 recall_decision 工具输出决策'
      );
      return this.parsePlan(toolCall.input);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'RecallPlanner 决策工具调用失败，保守不查询'
      );
      return { needsRecall: false, queries: [], reason: '决策工具调用失败，保守不查询' };
    }
  }

  /**
   * 执行召回计划，并行查询所有允许的类型
   */
  async execute(plan: RecallPlan): Promise<string[]> {
    if (!plan.needsRecall || plan.queries.length === 0) {
      return [];
    }

    const validQueries = plan.queries.filter((q) => {
      if (!this.enabledTypes.has(q.type)) {
        logger.warn({ query: q }, 'RecallPlanner 忽略未启用的 recall 类型');
        return false;
      }
      if (q.type === 'user_preferences' && !q.userId) {
        logger.warn({ query: q }, 'RecallPlanner 忽略缺少 userId 的 user_preferences 查询');
        return false;
      }
      return true;
    });

    if (validQueries.length === 0) {
      return [];
    }

    logger.info(
      { role: plan.queries[0]?.type, count: validQueries.length },
      'RecallPlanner 执行召回查询'
    );
    logMemorySnapshot('RecallPlanner.execute 开始');

    const results = await Promise.all(
      validQueries.map(async (q) => {
        try {
          const items = await this.executeQuery(q);
          return items;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message, query: q }, 'RecallPlanner 单条召回失败');
          return [];
        }
      })
    );

    const flat = results.flat();
    console.log(`[RecallPlanner] 召回总条目=${flat.length}, 总字符=${flat.reduce((sum, m) => sum + m.length, 0)}`);
    logMemorySnapshot('RecallPlanner.execute 结束');
    return flat;
  }

  private async executeQuery(query: RecallQuery): Promise<string[]> {
    switch (query.type) {
      case 'review':
        return this.memoryClient.recallForReview(query.query);
      case 'maintenance':
        return this.memoryClient.recallForMaintenance(query.query);
      case 'project_knowledge':
        return this.memoryClient.recallProjectKnowledge(query.query);
      case 'user_preferences':
        if (!query.userId) {
          return [];
        }
        return this.memoryClient.recallUserPreferences(query.userId, query.query);
      default:
        return [];
    }
  }

  private buildPrompt(input: RecallDecisionInput): string {
    if (this.customDecisionPrompt) {
      const findingsSection = input.availableFindings
        ? `\n当前已知的 findings：\n${input.availableFindings}`
        : '';
      return `${this.customDecisionPrompt}\n\n当前角色：${input.role}\n任务类型：${input.taskType}\n任务摘要：\n${input.taskSummary}${findingsSection}\n\n请输出 JSON：`;
    }

    return this.promptLoader.load('recall-decision', {
      role: input.role,
      taskType: input.taskType,
      taskSummary: input.taskSummary,
      availableFindings: input.availableFindings
        ? `\n当前已知的 findings：\n${input.availableFindings}`
        : '',
    });
  }

  private parsePlan(input: Record<string, unknown>): RecallPlan {
    try {
      const rawQueries = Array.isArray(input.queries) ? input.queries : [];
      const queries = rawQueries
        .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
        .map((q) => ({
          type: this.normalizeRecallType(String(q.type ?? '')),
          query: String(q.query ?? ''),
          userId: q.userId ? String(q.userId) : undefined,
        }))
        .filter((q) => q.type !== undefined && q.query.trim().length > 0) as RecallQuery[];

      return {
        needsRecall: input.needsRecall === true && queries.length > 0,
        queries,
        reason: String(input.reason ?? '未提供理由'),
      };
    } catch (err) {
      logger.warn(
        { input, err: err instanceof Error ? err.message : String(err) },
        'RecallPlanner 决策响应解析失败，fallback 到不查记忆'
      );
      return { needsRecall: false, queries: [], reason: '决策解析失败，保守不查' };
    }
  }

  private normalizeRecallType(type: string): RecallType | undefined {
    const valid: RecallType[] = ['review', 'maintenance', 'project_knowledge', 'user_preferences'];
    const lower = type.toLowerCase().trim();
    return valid.find((v) => v === lower || v.replace(/_/g, '') === lower.replace(/_/g, ''));
  }
}
