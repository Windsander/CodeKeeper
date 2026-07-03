import { describe, it, expect, vi } from 'vitest';
import { MaintainerBrain } from '../../../../src/advance/classic/fix/maintainer-brain.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { RecallPlanner } from '../../../../src/advance/classic/memory/recall-planner.js';
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
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;', mrIid: 1, userId: 'reviewer' });
    expect(decision.action).toBe('fix');
  });

  it('LLM 决策为 ask 时返回 ask 和问题', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(
        '{"action":"ask","reason":"需要澄清","question":"这里应该怎么改？"}'
      ),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;', mrIid: 1, userId: 'reviewer' });
    expect(decision.action).toBe('ask');
    expect(decision.question).toBe('这里应该怎么改？');
  });

  it('LLM 决策为 ignore 时返回 ignore', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"ignore","reason":"不相关"}'),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;', mrIid: 1, userId: 'reviewer' });
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
      mrIid: 1,
      userId: 'reviewer',
    });
    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain('HIGH');
  });

  it('LLM 返回非法 JSON 时保守 ask', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('不是 JSON'),
    });
    const decision = await brain.decide({ finding: makeFinding(), fileContent: 'const x = 1;', mrIid: 1, userId: 'reviewer' });
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

  it('决策前召回用户偏好并拼入 prompt', async () => {
    const complete = vi.fn().mockResolvedValue('{"action":"fix","reason":"可以安全修复"}');
    const llmClient = { complete } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const memoryClient = {
      recallUserPreferences: vi.fn().mockResolvedValue(['该用户偏好显式类型注解']),
      recallProjectKnowledge: vi.fn().mockResolvedValue([]),
      recallForMaintenance: vi.fn().mockResolvedValue([]),
      recordFixAttempt: vi.fn(),
    } as unknown as NonNullable<
      import('../../../../src/advance/classic/fix/maintainer-brain.js').MaintainerBrainOptions['memoryClient']
    >;

    const brain = new MaintainerBrain({ llmClient, memoryClient });
    await brain.decide({
      finding: makeFinding(),
      fileContent: 'const x = 1;',
      originalComment: '加个类型',
      mrIid: 1,
      userId: 'alice',
    });

    expect(memoryClient.recallUserPreferences).toHaveBeenCalledWith('alice', expect.any(String));
    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt).toContain('该用户偏好显式类型注解');
  });

  it('决策前通过 RecallPlanner 按需召回记忆并拼入 prompt', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          needsRecall: true,
          queries: [{ type: 'maintenance', query: '类似问题的修复历史' }],
          reason: '需要参考历史修复',
        })
      )
      .mockResolvedValueOnce('{"action":"fix","reason":"可以安全修复"}');
    const llmClient = { complete } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const memoryClient = {
      recallUserPreferences: vi.fn().mockResolvedValue([]),
      recallProjectKnowledge: vi.fn().mockResolvedValue([]),
      recallForMaintenance: vi.fn().mockResolvedValue(['历史修复方式：显式类型注解']),
      recallForReview: vi.fn().mockResolvedValue([]),
      recordFixAttempt: vi.fn(),
    } as unknown as NonNullable<
      import('../../../../src/advance/classic/fix/maintainer-brain.js').MaintainerBrainOptions['memoryClient']
    >;
    const recallPlanner = new RecallPlanner({ llmClient, memoryClient });

    const brain = new MaintainerBrain({ llmClient, memoryClient, recallPlanner });
    await brain.decide({
      finding: makeFinding(),
      fileContent: 'const x = 1;',
      originalComment: '加个类型',
      mrIid: 1,
      userId: 'alice',
    });

    expect(memoryClient.recallForMaintenance).toHaveBeenCalled();
    expect(memoryClient.recallUserPreferences).not.toHaveBeenCalled();
    const prompt = complete.mock.calls[1][0] as string;
    expect(prompt).toContain('历史修复方式：显式类型注解');
  });

  it('从 summary 中解析多条 finding', async () => {
    const summary = `
- 🔴 **高** (1)
  - \`src/a.ts:10\` · 规则 \`R1\` 问题 A<br>**建议**：改成 X
- 🟠 **中** (1)
  - \`src/b.ts:20\` · 规则 \`R2\` 问题 B<br>**建议**：改成 Y
`;
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(JSON.stringify([
        { severity: 'HIGH', file: 'src/a.ts', line: 10, ruleId: 'R1', message: '问题 A', suggestion: '改成 X', autoFixable: true },
        { severity: 'MEDIUM', file: 'src/b.ts', line: 20, ruleId: 'R2', message: '问题 B', suggestion: '改成 Y', autoFixable: false },
      ])),
    });
    const findings = await brain.parseFindings({ body: summary, isSummary: true });
    expect(findings).toHaveLength(2);
    expect(findings[0].file).toBe('src/a.ts');
  });

  it('thread 评论缺少行号时使用 position 兜底', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(JSON.stringify([
        { severity: 'MEDIUM', message: '问题', suggestion: '建议' },
      ])),
    });
    const findings = await brain.parseFindings({
      body: '这里有个问题',
      position: { newPath: 'src/c.ts', newLine: 5 },
    });
    expect(findings[0].file).toBe('src/c.ts');
    expect(findings[0].line).toBe(5);
  });

  it('无修复点的评论返回空数组', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(JSON.stringify([])),
    });
    const findings = await brain.parseFindings({ body: '👍 看起来不错' });
    expect(findings).toHaveLength(0);
  });

  it('LLM 返回 markdown JSON 也能解析', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('```json\n[]\n```'),
    });
    const findings = await brain.parseFindings({ body: 'ok' });
    expect(findings).toHaveLength(0);
  });
});
