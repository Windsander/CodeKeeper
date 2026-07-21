import { describe, it, expect, vi } from 'vitest';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { RecallPlanner } from '../../../../src/advance/classic/memory/recall-planner.js';
import type { IMemoryClient } from '../../../../src/advance/classic/memory/types.js';

function createMockLlm(input: Record<string, unknown>): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: {
      toolResponses: [
        {
          toolCalls: [{ id: '1', name: 'recall_decision', input }],
        },
      ],
    },
  });
}

function createMemoryClient(): IMemoryClient {
  return {
    recordReview: vi.fn(),
    recordFixAttempt: vi.fn(),
    recordInteraction: vi.fn(),
    recordProjectKnowledge: vi.fn(),
    recordFindingCases: vi.fn(),
    recordReflection: vi.fn(),
    recallFindingCase: vi.fn().mockResolvedValue([]),
    recallForReview: vi.fn().mockResolvedValue(['review memory']),
    recallForMaintenance: vi.fn().mockResolvedValue(['maintenance memory']),
    recallProjectKnowledge: vi.fn().mockResolvedValue(['knowledge memory']),
    recallUserPreferences: vi.fn().mockResolvedValue(['user preference']),
    flush: vi.fn(),
  } as unknown as IMemoryClient;
}

describe('RecallPlanner', () => {
  it('LLM 决定不查时返回空计划', async () => {
    const llmClient = createMockLlm({ needsRecall: false, queries: [], reason: '当前任务不需要记忆' });
    const memoryClient = createMemoryClient();
    const planner = new RecallPlanner({ llmClient, memoryClient });

    const plan = await planner.plan({
      role: 'reviewer',
      taskType: 'review',
      taskSummary: '简单的 MR',
    });

    expect(plan.needsRecall).toBe(false);
    expect(plan.queries).toHaveLength(0);
    const memories = await planner.execute(plan);
    expect(memories).toHaveLength(0);
  });

  it('LLM 决定查 review 时生成正确 query 并路由到 recallForReview', async () => {
    const llmClient = createMockLlm({
      needsRecall: true,
      queries: [{ type: 'review', query: '历史评审经验' }],
      reason: '需要参考历史评审',
    });
    const memoryClient = createMemoryClient();
    const planner = new RecallPlanner({ llmClient, memoryClient });

    const plan = await planner.plan({
      role: 'reviewer',
      taskType: 'review',
      taskSummary: '改动较大的 MR',
    });

    expect(plan.needsRecall).toBe(true);
    expect(plan.queries).toEqual([{ type: 'review', query: '历史评审经验' }]);

    const memories = await planner.execute(plan);
    expect(memoryClient.recallForReview).toHaveBeenCalledWith('历史评审经验');
    expect(memories).toEqual(['review memory']);
  });

  it('支持多类型查询并并行路由', async () => {
    const llmClient = createMockLlm({
      needsRecall: true,
      queries: [
        { type: 'project_knowledge', query: '项目规范' },
        { type: 'maintenance', query: '修复历史' },
        { type: 'user_preferences', query: '用户习惯', userId: 'alice' },
      ],
      reason: '需要多方面记忆',
    });
    const memoryClient = createMemoryClient();
    const planner = new RecallPlanner({ llmClient, memoryClient });

    const plan = await planner.plan({
      role: 'maintainer',
      taskType: 'fix',
      taskSummary: '处理 finding',
    });

    const memories = await planner.execute(plan);
    expect(memoryClient.recallProjectKnowledge).toHaveBeenCalledWith('项目规范');
    expect(memoryClient.recallForMaintenance).toHaveBeenCalledWith('修复历史');
    expect(memoryClient.recallUserPreferences).toHaveBeenCalledWith('alice', '用户习惯');
    expect(memories).toEqual(['knowledge memory', 'maintenance memory', 'user preference']);
  });

  it('过滤 enabledTypes 之外的类型', async () => {
    const llmClient = createMockLlm({
      needsRecall: true,
      queries: [
        { type: 'review', query: 'q1' },
        { type: 'project_knowledge', query: 'q2' },
      ],
      reason: '',
    });
    const memoryClient = createMemoryClient();
    const planner = new RecallPlanner({
      llmClient,
      memoryClient,
      enabledTypes: ['review'],
    });

    const plan = await planner.plan({ role: 'reviewer', taskType: 'review', taskSummary: '' });
    const memories = await planner.execute(plan);

    expect(memoryClient.recallForReview).toHaveBeenCalledWith('q1');
    expect(memoryClient.recallProjectKnowledge).not.toHaveBeenCalled();
    expect(memories).toEqual(['review memory']);
  });

  it('user_preferences 缺少 userId 时被忽略', async () => {
    const llmClient = createMockLlm({
      needsRecall: true,
      queries: [{ type: 'user_preferences', query: '习惯' }],
      reason: '',
    });
    const memoryClient = createMemoryClient();
    const planner = new RecallPlanner({ llmClient, memoryClient });

    const plan = await planner.plan({ role: 'maintainer', taskType: 'fix', taskSummary: '' });
    const memories = await planner.execute(plan);

    expect(memoryClient.recallUserPreferences).not.toHaveBeenCalled();
    expect(memories).toHaveLength(0);
  });

  it('LLM 决策工具调用失败时 fallback 到不查', async () => {
    const llmClient = new LlmClient({ apiKey: 'test', mock: { response: '不是 JSON' } });
    const memoryClient = createMemoryClient();
    const planner = new RecallPlanner({ llmClient, memoryClient });

    const plan = await planner.plan({ role: 'reviewer', taskType: 'review', taskSummary: '' });

    expect(plan.needsRecall).toBe(false);
    expect(plan.queries).toHaveLength(0);
  });

  it('execute 中单条查询失败不影响其他查询', async () => {
    const memoryClient = createMemoryClient();
    memoryClient.recallForReview = vi.fn().mockRejectedValue(new Error('网络错误'));

    const llmClient = createMockLlm({
      needsRecall: true,
      queries: [{ type: 'review', query: 'q1' }],
      reason: '',
    });
    const planner = new RecallPlanner({ llmClient, memoryClient });

    const plan = await planner.plan({ role: 'reviewer', taskType: 'review', taskSummary: '' });
    const memories = await planner.execute(plan);

    expect(memories).toHaveLength(0);
  });
});
