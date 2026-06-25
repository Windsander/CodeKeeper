import { describe, it, expect } from 'vitest';
import { MaintainerBrain } from '../../../../src/advance/classic/fix/maintainer-brain.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'MEDIUM',
    file: 'src/index.ts',
    line: 1,
    message: '问题',
    suggestion: '建议',
    ...overrides,
  };
}

function createMockLlmClient(response: string): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: { response },
  });
}

describe('MaintainerBrain', () => {
  it('LLM 决策为 fix 时返回 fix', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix","reason":"可以安全修复"}'),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;' });
    expect(decision.action).toBe('fix');
  });

  it('LLM 决策为 ask 时返回 ask 和问题', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(
        '{"action":"ask","reason":"需要澄清","question":"这里应该怎么改？"}'
      ),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;' });
    expect(decision.action).toBe('ask');
    expect(decision.question).toBe('这里应该怎么改？');
  });

  it('LLM 决策为 ignore 时返回 ignore', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"ignore","reason":"不相关"}'),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;' });
    expect(decision.action).toBe('ignore');
  });

  it('风险等级未开启时直接 ask，不调用 LLM', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix"}'),
      allowedRiskLevels: ['LOW'],
    });
    const decision = await brain.decide({
      finding: makeFinding({ severity: 'HIGH' }),
      fileContent: 'const x = 1;',
    });
    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain('HIGH');
  });

  it('LLM 返回非法 JSON 时保守 ask', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('不是 JSON'),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;' });
    expect(decision.action).toBe('ask');
  });

  it('decideReply 能解析交互回复后的 fix 决策', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(
        '{"action":"fix","reason":"现在可以修了","fixDescription":"把 x 改成 2"}'
      ),
    });
    const decision = await brain.decideReply({
      filePath: 'src/index.ts',
      fileContent: 'const x = 1;',
      threadNotes: [
        { author: 'reviewer', body: '这里应该改成 2', createdAt: '2026-01-01T00:00:00Z' },
      ],
      maintainerName: 'CodeKeeper Maintainer',
    });
    expect(decision.action).toBe('fix');
    expect(decision.fixDescription).toBe('把 x 改成 2');
  });
});
