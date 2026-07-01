import { describe, it, expect, vi } from 'vitest';
import { ReviewerBrain } from '../../../../src/advance/classic/review/reviewer-brain.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
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

  it('LLM 返回非法 JSON 时返回降级结果', async () => {
    const brain = new ReviewerBrain({
      llmClient: createMockLlmClient('不是 JSON'),
      tokenBudget: 4000,
      rules: 'rule1',
    });

    const result = await brain.review(mockMR, mockDiffs);

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('解析失败');
  });

  it('评审前召回项目知识并拼入 prompt', async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({ findings: [], summary: 'ok', autoFixable: [] })
    );
    const llmClient = { complete } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const memoryClient = {
      recallForReview: vi.fn().mockResolvedValue(['项目使用 TypeScript 严格模式']),
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

    expect(memoryClient.recallForReview).toHaveBeenCalled();
    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt).toContain('项目使用 TypeScript 严格模式');
  });
});
