import { logger } from '../../../core/logger.js';
import type { LlmClient } from '../../llm/client.js';
import type { IMemoryClient } from './types.js';

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
  private readonly decisionPrompt: string;

  constructor(options: RecallPlannerOptions) {
    this.llmClient = options.llmClient;
    this.memoryClient = options.memoryClient;
    this.enabledTypes = new Set(options.enabledTypes ?? ALL_RECALL_TYPES);
    this.decisionPrompt = options.decisionPrompt ?? this.buildDefaultDecisionPrompt();
  }

  /**
   * 根据任务上下文生成召回计划
   */
  async plan(input: RecallDecisionInput): Promise<RecallPlan> {
    const prompt = this.buildPrompt(input);
    const response = await this.llmClient.complete(
      prompt,
      '你是记忆查询决策助手，只输出 JSON。'
    );
    return this.parsePlan(response);
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

    return results.flat();
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
        return this.memoryClient.recallUserPreferences(query.userId!, query.query);
      default:
        return [];
    }
  }

  private buildPrompt(input: RecallDecisionInput): string {
    const findingsSection = input.availableFindings
      ? `\n当前已知的 findings：\n${input.availableFindings}`
      : '';

    return `${this.decisionPrompt}\n\n当前角色：${input.role}\n任务类型：${input.taskType}\n任务摘要：\n${input.taskSummary}${findingsSection}\n\n请输出 JSON：`;
  }

  private buildDefaultDecisionPrompt(): string {
    return `你是一名记忆查询决策助手。请根据当前任务上下文，判断是否需要查询历史记忆。

可查询的记忆类型：
- review：与该 MR / 代码变更相关的历史评审经验。
- maintenance：与该问题相关的历史修复/维护经验。
- project_knowledge：项目规范、架构约定、通用知识。
- user_preferences：当前交互用户的历史偏好与习惯（必须提供 userId 时才使用）。

决策原则：
- 只有当任务明显能从历史记忆中受益时才查询（例如需要上下文、用户偏好、往期类似问题）。
- 如果是简单问候、感谢、emoji、明显不需要记忆的判断，needsRecall 应为 false。
- 不要为了查询而查询，避免浪费资源。
- 如果需要查询，给出 1~3 条具体 query，每条 query 应简洁且与任务相关。

输出格式：
{
  "needsRecall": true|false,
  "queries": [
    { "type": "review|maintenance|project_knowledge|user_preferences", "query": "...", "userId": "..." }
  ],
  "reason": "简短说明"
}`;
  }

  private parsePlan(rawResponse: string): RecallPlan {
    try {
      const cleaned = this.extractJsonFromMarkdown(rawResponse);
      const parsed = JSON.parse(cleaned) as {
        needsRecall?: boolean;
        queries?: unknown[];
        reason?: string;
      };

      const queries = this.normalizeQueries(parsed.queries ?? []);
      return {
        needsRecall: parsed.needsRecall === true && queries.length > 0,
        queries,
        reason: parsed.reason ?? '未提供理由',
      };
    } catch (err) {
      logger.warn(
        { rawResponse: rawResponse.slice(0, 500), err: err instanceof Error ? err.message : String(err) },
        'RecallPlanner 决策响应解析失败，fallback 到不查记忆'
      );
      return { needsRecall: false, queries: [], reason: '决策解析失败，保守不查' };
    }
  }

  private normalizeQueries(rawQueries: unknown[]): RecallQuery[] {
    return rawQueries
      .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
      .map((q) => ({
        type: this.normalizeRecallType(String(q.type ?? '')),
        query: String(q.query ?? ''),
        userId: q.userId ? String(q.userId) : undefined,
      }))
      .filter((q) => q.type !== undefined && q.query.trim().length > 0) as RecallQuery[];
  }

  private normalizeRecallType(type: string): RecallType | undefined {
    const valid: RecallType[] = ['review', 'maintenance', 'project_knowledge', 'user_preferences'];
    const lower = type.toLowerCase().trim();
    return valid.find((v) => v === lower || v.replace(/_/g, '') === lower.replace(/_/g, ''));
  }

  private extractJsonFromMarkdown(text: string): string {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return text.trim();
  }
}
