import { describe, it, expect, vi } from 'vitest';
import { ClassicReviewer } from '../../../../src/advance/classic/review/reviewer.js';
import type { MergeRequest, MrDiff, ReviewFinding } from '../../../../src/advance/classic/provider/types.js';
import type { LlmClient } from '../../../../src/advance/llm/client.js';

/**
 * 构造 mock LlmClient
 */
function createMockClient(response: string): LlmClient {
  return {
    complete: vi.fn().mockResolvedValue(response),
  } as unknown as LlmClient;
}

/**
 * 构造 mock LlmClient（支持多响应）
 */
function createMockClientWithResponses(responses: string[]): LlmClient {
  let callIndex = 0;
  return {
    complete: vi.fn().mockImplementation(() => {
      const resp = responses[callIndex] ?? '';
      callIndex++;
      return Promise.resolve(resp);
    }),
  } as unknown as LlmClient;
}

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test MR',
  description: 'Add feature X',
  sourceBranch: 'feature/x',
  targetBranch: 'main',
  author: 'dev1',
  draft: false,
  changesCount: 2,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  webUrl: 'https://example.com/mr/1',
};

const mockDiffs: MrDiff[] = [
  {
    filePath: 'src/index.ts',
    oldPath: 'src/index.ts',
    newPath: 'src/index.ts',
    newFile: false,
    deletedFile: false,
    diff: '@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n console.log(a);',
    additions: 1,
    deletions: 0,
  },
];

describe('ClassicReviewer', () => {
  describe('review', () => {
    it('空 diff 时返回空结果', async () => {
      const client = createMockClient('');
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });
      const result = await reviewer.review(mockMR, []);

      expect(result.findings).toHaveLength(0);
      expect(result.summary).toBe('No changes to review');
      expect(result.autoFixable).toHaveLength(0);
      expect(client.complete).not.toHaveBeenCalled();
    });

    it('正常解析 LLM 返回的 JSON 评审结果', async () => {
      const jsonResponse = JSON.stringify({
        findings: [
          {
            severity: 'HIGH',
            file: 'src/index.ts',
            line: 2,
            ruleId: 'RULE-001',
            message: '变量 b 未使用',
            suggestion: '删除未使用变量 b',
            autoFixable: true,
          },
          {
            severity: 'LOW',
            file: 'src/index.ts',
            line: 3,
            message: '缺少分号',
            suggestion: '添加分号',
            autoFixable: true,
          },
        ],
        summary: '发现 2 个问题',
        autoFixable: [0, 1],
      });

      const client = createMockClient(jsonResponse);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });
      const result = await reviewer.review(mockMR, mockDiffs);

      expect(result.findings).toHaveLength(2);
      expect(result.findings[0].severity).toBe('HIGH');
      expect(result.findings[0].file).toBe('src/index.ts');
      expect(result.findings[0].line).toBe(2);
      expect(result.findings[0].ruleId).toBe('RULE-001');
      expect(result.findings[0].message).toBe('变量 b 未使用');
      expect(result.findings[0].suggestion).toBe('删除未使用变量 b');
      expect(result.findings[0].autoFixable).toBe(true);

      expect(result.findings[1].severity).toBe('LOW');
      expect(result.summary).toBe('发现 2 个问题');
      expect(result.autoFixable).toEqual([0, 1]);
      expect(result.rawResponse).toBe(jsonResponse);
    });

    it('解析 markdown 代码块包裹的 JSON', async () => {
      const markdownJson = '```json\n' + JSON.stringify({
        findings: [
          {
            severity: 'MEDIUM',
            file: 'src/index.ts',
            line: 1,
            message: '问题描述',
            suggestion: '修改建议',
          },
        ],
        summary: '1 个问题',
        autoFixable: [],
      }) + '\n```';

      const client = createMockClient(markdownJson);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });
      const result = await reviewer.review(mockMR, mockDiffs);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('MEDIUM');
      expect(result.summary).toBe('1 个问题');
    });

    it('解析失败时返回降级结果', async () => {
      const invalidResponse = '这不是有效的 JSON';
      const client = createMockClient(invalidResponse);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });
      const result = await reviewer.review(mockMR, mockDiffs);

      expect(result.findings).toHaveLength(0);
      expect(result.summary).toBe('评审响应解析失败，请检查 LLM 输出格式');
      expect(result.autoFixable).toHaveLength(0);
      expect(result.rawResponse).toBe(invalidResponse);
    });

    it('severity 非法值降级为 LOW', async () => {
      const jsonResponse = JSON.stringify({
        findings: [
          {
            severity: 'INVALID',
            file: 'src/index.ts',
            line: 1,
            message: '问题',
            suggestion: '建议',
          },
        ],
        summary: '总结',
      });

      const client = createMockClient(jsonResponse);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });
      const result = await reviewer.review(mockMR, mockDiffs);

      expect(result.findings[0].severity).toBe('LOW');
    });

    it('autoFixable 从 finding 字段推导', async () => {
      const jsonResponse = JSON.stringify({
        findings: [
          { severity: 'HIGH', file: 'a.ts', line: 1, message: 'm1', suggestion: 's1', autoFixable: true },
          { severity: 'LOW', file: 'b.ts', line: 2, message: 'm2', suggestion: 's2', autoFixable: false },
          { severity: 'MEDIUM', file: 'c.ts', line: 3, message: 'm3', suggestion: 's3' },
        ],
        summary: '总结',
      });

      const client = createMockClient(jsonResponse);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });
      const result = await reviewer.review(mockMR, mockDiffs);

      expect(result.autoFixable).toEqual([0]);
    });

    it('调用 complete 时传入正确的 system prompt 和 maxTokens 计算', async () => {
      const jsonResponse = JSON.stringify({ findings: [], summary: '无问题', autoFixable: [] });
      const client = createMockClient(jsonResponse);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 100000, rules: 'rule1' });
      await reviewer.review(mockMR, mockDiffs);

      expect(client.complete).toHaveBeenCalledTimes(1);
      const [, systemPrompt] = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(systemPrompt).toBe('你是严格的代码评审助手。请只输出 JSON。');
    });
  });

  describe('generateFix', () => {
    it('清理 markdown 代码块包装', async () => {
      const fixCode = 'const a = 1;\nconst b = 2;\nconsole.log(a, b);';
      const markdownWrapped = '```typescript\n' + fixCode + '\n```';

      const client = createMockClient(markdownWrapped);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });

      const finding: ReviewFinding = {
        severity: 'HIGH',
        file: 'src/index.ts',
        line: 2,
        message: '变量未使用',
        suggestion: '使用或删除变量',
      };

      const result = await reviewer.generateFix('src/index.ts', 'const a = 1;\nconsole.log(a);', finding);
      expect(result).toBe(fixCode);
    });

    it('无代码块包装时直接返回内容', async () => {
      const fixCode = 'const a = 1;\nconsole.log(a);';

      const client = createMockClient(fixCode);
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });

      const finding: ReviewFinding = {
        severity: 'LOW',
        file: 'src/index.ts',
        line: 1,
        message: '格式问题',
        suggestion: '调整格式',
      };

      const result = await reviewer.generateFix('src/index.ts', 'old', finding);
      expect(result).toBe(fixCode);
    });

    it('空响应返回 null', async () => {
      const client = createMockClient('   ');
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });

      const finding: ReviewFinding = {
        severity: 'MEDIUM',
        file: 'src/index.ts',
        line: 1,
        message: '问题',
        suggestion: '建议',
      };

      const result = await reviewer.generateFix('src/index.ts', 'old', finding);
      expect(result).toBeNull();
    });

    it('调用 complete 时不传 system prompt', async () => {
      const client = createMockClient('fixed');
      const reviewer = new ClassicReviewer({ client, tokenBudget: 4000, rules: 'rule1' });

      const finding: ReviewFinding = {
        severity: 'HIGH',
        file: 'src/index.ts',
        line: 2,
        message: '变量未使用',
        suggestion: '使用或删除变量',
      };

      await reviewer.generateFix('src/index.ts', 'old', finding);
      expect(client.complete).toHaveBeenCalledTimes(1);
      const [, systemPrompt] = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(systemPrompt).toBeUndefined();
    });
  });
});
