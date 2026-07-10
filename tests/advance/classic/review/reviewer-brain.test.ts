import { describe, it, expect, vi } from 'vitest';
import { ReviewerBrain } from '../../../../src/advance/classic/review/reviewer-brain.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { RecallPlanner } from '../../../../src/advance/classic/memory/recall-planner.js';
import type { MergeRequest, MrDiff } from '../../../../src/advance/classic/provider/types.js';

function createMockLlmClient(response: string): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: { response },
  });
}

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test MR',
  description: '',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  author: 'dev',
  draft: false,
  changesCount: 1,
  createdAt: '',
  updatedAt: '',
  webUrl: '',
};

const mockDiffs: MrDiff[] = [
  {
    oldPath: 'src/index.ts',
    newPath: 'src/index.ts',
    newFile: false,
    deletedFile: false,
    diff: '+const x = 1',
  },
];

describe('ReviewerBrain', () => {
  it('解析 LLM 返回的 findings 和 summary', async () => {
    const brain = new ReviewerBrain({
      llmClient: createMockLlmClient(
        JSON.stringify({
          findings: [
            {
              severity: 'HIGH',
              file: 'src/index.ts',
              line: 10,
              message: '问题',
              suggestion: '建议',
              autoFixable: true,
            },
          ],
          summary: '发现一个 HIGH 问题',
          autoFixable: [0],
        })
      ),
      tokenBudget: 4000,
      rules: 'rule1',
    });

    const result = await brain.review(mockMR, mockDiffs);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('HIGH');
    expect(result.summary).toContain('HIGH');
    expect(result.autoFixable).toContain(0);
  });

  it('空 diff 时返回空 findings', async () => {
    const brain = new ReviewerBrain({
      llmClient: createMockLlmClient(''),
      tokenBudget: 4000,
      rules: 'rule1',
    });

    const result = await brain.review(mockMR, []);

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe('No changes to review');
  });

  it('非法 severity 归一化为 LOW', async () => {
    const brain = new ReviewerBrain({
      llmClient: createMockLlmClient(
        JSON.stringify({
          findings: [{ severity: 'unknown', file: 'a.ts', line: 1, message: 'm', suggestion: 's' }],
          summary: 's',
        })
      ),
      tokenBudget: 4000,
      rules: 'rule1',
    });

    const result = await brain.review(mockMR, mockDiffs);

    expect(result.findings[0].severity).toBe('LOW');
  });

  it('LLM 返回非法 JSON 时抛出解析失败错误，不把错误内容写入记忆', async () => {
    const brain = new ReviewerBrain({
      llmClient: createMockLlmClient('不是 JSON'),
      tokenBudget: 4000,
      rules: 'rule1',
    });

    await expect(brain.review(mockMR, mockDiffs)).rejects.toThrow('评审响应解析失败');
  });

  it('评审前通过 RecallPlanner 按需召回记忆并拼入 prompt', async () => {
    const completeDecision = vi.fn().mockResolvedValue({
      id: '1',
      name: 'recall_decision',
      input: {
        needsRecall: true,
        queries: [{ type: 'review', query: 'TypeScript 严格模式相关评审' }],
        reason: '需要历史经验',
      },
    });
    const completeJson = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ findings: [], summary: 'ok', autoFixable: [] }));
    const llmClient = {
      complete: vi.fn(),
      completeJson,
      completeDecision,
    } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const memoryClient = {
      recallForReview: vi.fn().mockResolvedValue(['项目使用 TypeScript 严格模式']),
    } as unknown as NonNullable<
      import('../../../../src/advance/classic/review/reviewer-brain.js').ReviewerBrainOptions['memoryClient']
    >;
    const recallPlanner = new RecallPlanner({ llmClient, memoryClient });

    const brain = new ReviewerBrain({
      llmClient,
      tokenBudget: 4000,
      rules: 'rule1',
      recallPlanner,
    });
    await brain.review(mockMR, mockDiffs);

    expect(memoryClient.recallForReview).toHaveBeenCalled();
    const prompt = completeJson.mock.calls[0][0] as string;
    expect(prompt).toContain('项目使用 TypeScript 严格模式');
  });

  it('没有 recallPlanner 时 review 不查记忆', async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ findings: [], summary: 'ok', autoFixable: [] }));
    const llmClient = { complete, completeJson: complete } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const memoryClient = {
      recallForReview: vi.fn().mockResolvedValue([]),
    } as unknown as NonNullable<
      import('../../../../src/advance/classic/review/reviewer-brain.js').ReviewerBrainOptions['memoryClient']
    >;

    const brain = new ReviewerBrain({
      llmClient,
      tokenBudget: 4000,
      rules: 'rule1',
      memoryClient,
    });
    await brain.review(mockMR, mockDiffs);

    expect(memoryClient.recallForReview).not.toHaveBeenCalled();
  });

  it('replyToComment 通过 RecallPlanner 按需召回记忆并控制讨论历史长度', async () => {
    const completeDecision = vi.fn().mockResolvedValue({
      id: '1',
      name: 'recall_decision',
      input: {
        needsRecall: true,
        queries: [{ type: 'review', query: '历史 medium issue 处理方式' }],
        reason: '需要历史参考',
      },
    });
    const completeJson = vi.fn().mockResolvedValue(
      JSON.stringify({
        shouldReply: true,
        replyBody: '历史上类似问题是这样处理的：...',
        reason: '用户询问历史处理方式',
      })
    );
    const llmClient = {
      complete: vi.fn().mockResolvedValue('讨论摘要'),
      completeJson,
      completeDecision,
    } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const memoryClient = {
      recallForReview: vi.fn().mockResolvedValue(['历史处理方式 A', '历史处理方式 B']),
    } as unknown as NonNullable<
      import('../../../../src/advance/classic/review/reviewer-brain.js').ReviewerBrainOptions['memoryClient']
    >;
    const recallPlanner = new RecallPlanner({ llmClient, memoryClient });

    const brain = new ReviewerBrain({
      llmClient,
      tokenBudget: 4000,
      rules: 'rule1',
      recallPlanner,
    });

    const threadNotes = [
      { author: 'alice', body: '问题1', createdAt: '2026-07-03T06:00:00Z' },
      { author: 'reviewer', body: '回复1', createdAt: '2026-07-03T06:01:00Z' },
      { author: 'alice', body: '为什么？', createdAt: '2026-07-03T06:02:00Z' },
    ];

    const result = await brain.replyToComment({
      mr: mockMR,
      originalFindings: [],
      threadNotes,
      targetNote: { author: 'alice', body: '为什么？', createdAt: '2026-07-03T06:02:00Z' },
    });

    expect(result.shouldReply).toBe(true);
    expect(result.replyBody).toContain('历史上');
    expect(memoryClient.recallForReview).toHaveBeenCalled();
    const prompt = completeJson.mock.calls[0][0] as string;
    expect(prompt).toContain('历史处理方式 A');
  });

  it('replyToComment 对长 threadNotes 生成摘要并保留最近原文', async () => {
    const longNotes = Array.from({ length: 20 }, (_, i) => ({
      author: i % 2 === 0 ? 'alice' : 'reviewer',
      body: `这是第 ${i + 1} 条评论，内容较长，${'x'.repeat(3000)}`,
      createdAt: `2026-07-03T06:${String(i).padStart(2, '0')}:00Z`,
    }));

    const summaryResponse = '早期评论摘要：用户在追问 medium issue 的处理方式。';
    const completeDecision = vi.fn().mockResolvedValue({
      id: '1',
      name: 'recall_decision',
      input: { needsRecall: false, queries: [], reason: '已有足够上下文' },
    });
    const completeJson = vi.fn().mockResolvedValue(
      JSON.stringify({ shouldReply: true, replyBody: '请参考上述说明。', reason: '用户追问' })
    );

    const llmClient = {
      complete: vi.fn().mockResolvedValueOnce(summaryResponse).mockResolvedValue(''),
      completeJson,
      completeDecision,
    } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const recallPlanner = new RecallPlanner({
      llmClient,
      memoryClient: {
        recallForReview: vi.fn().mockResolvedValue([]),
        recallForMaintenance: vi.fn().mockResolvedValue([]),
        recallProjectKnowledge: vi.fn().mockResolvedValue([]),
        recallUserPreferences: vi.fn().mockResolvedValue([]),
      } as unknown as import('../../../../src/advance/classic/memory/types.js').IMemoryClient,
    });

    const brain = new ReviewerBrain({
      llmClient,
      tokenBudget: 4000,
      rules: 'rule1',
      recallPlanner,
    });

    const result = await brain.replyToComment({
      mr: mockMR,
      originalFindings: [],
      threadNotes: longNotes,
      targetNote: { author: 'alice', body: '为什么？', createdAt: '2026-07-03T06:19:00Z' },
    });

    expect(result.shouldReply).toBe(true);
    const prompt = completeJson.mock.calls[0][0] as string;
    expect(prompt).toContain('早期评论摘要');
    expect(prompt).toContain('【最近评论】');
  });
});
