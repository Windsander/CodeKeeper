import { describe, it, expect, vi } from 'vitest';
import { MaintainerBrain } from '../../../../src/advance/classic/fix/maintainer-brain.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { RecallPlanner } from '../../../../src/advance/classic/memory/recall-planner.js';
import type { ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'MEDIUM',
    file: 'src/index.ts',
    line: 5,
    message: '函数逻辑需要调整',
    suggestion: '重构该函数的实现',
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

  it('decide 返回 CognitiveDecision 包含 reasoning', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient(
        JSON.stringify({
          action: 'fix',
          reason: '可以修复',
          fixDescription: '修复描述',
          analysis: '问题分析',
          consideredOptions: ['方案A', '方案B'],
          reasoning: '选择方案A因为风险低',
          confidence: 'high',
        })
      ),
      cognitiveDepth: 'fast',
    });
    const decision = await brain.decide({
      finding: makeFinding(),
      fileContent: 'const a = 1;\n',
      originalComment: '有个问题',
      mrIid: 1,
      userId: 'reviewer',
    });

    expect(decision.action).toBe('fix');
    expect(decision.reasoning).toBe('选择方案A因为风险低');
    expect(decision.consideredOptions).toEqual(['方案A', '方案B']);
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

    const brain = new MaintainerBrain({
      llmClient,
      memoryClient,
      recallPlanner,
      cognitiveDepth: 'fast',
    });
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

describe('MaintainerBrain 聚焦上下文与范围分类', () => {
  function createMockLlmClient(response: string): LlmClient {
    return new LlmClient({
      apiKey: 'test',
      mock: { response },
    });
  }

  it('决策中包含范围分类 scope', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix","reason":"可以安全修复"}'),
    });
    const decision = await brain.decide({
      finding: makeFinding(),
      fileContent: 'const x = 1;',
      mrIid: 1,
      userId: 'reviewer',
    });
    expect(decision.scope).toBeDefined();
    expect(['trivial', 'local', 'cross-file', 'needs-clarification']).toContain(decision.scope);
  });

  it('缺少行号时判定为 needs-clarification 并询问', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix","reason":"可以安全修复"}'),
    });
    const decision = await brain.decide({
      finding: makeFinding({ line: 0 }),
      fileContent: 'const x = 1;',
      mrIid: 1,
      userId: 'reviewer',
    });
    expect(decision.action).toBe('ask');
    expect(decision.scope).toBe('needs-clarification');
  });

  it('prompt 中使用聚焦代码片段和 imports', async () => {
    const complete = vi.fn().mockResolvedValue('{"action":"fix","reason":"可以安全修复","analysis":"分析","consideredOptions":[],"reasoning":"理由","confidence":"medium"}');
    const llmClient = { complete } as unknown as import('../../../../src/advance/llm/client.js').LlmClient;
    const brain = new MaintainerBrain({ llmClient, cognitiveDepth: 'fast' });

    const fileContent = `import { foo } from './foo';\n\nfunction target() {\n  const x = 1;\n  return x;\n}\n`;
    await brain.decide({
      finding: makeFinding({ line: 4 }),
      fileContent,
      mrIid: 1,
      userId: 'reviewer',
    });

    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt).toContain('相关代码');
    expect(prompt).toContain("import { foo } from './foo';");
    expect(prompt).toContain('function target');
    expect(prompt).not.toContain('文件内容（节选）');
  });

  it('类型变更问题被分类为 cross-file', async () => {
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix","reason":"需要改多个调用点"}'),
    });
    const decision = await brain.decide({
      finding: makeFinding({
        line: 10,
        message: 'MemoryLlmCallParams 接口定义缺少 error 字段',
        suggestion: '扩展接口定义并同步所有调用点',
        ruleId: 'TYPE-SAFETY',
      }),
      fileContent: 'interface MemoryLlmCallParams {}',
      mrIid: 1,
      userId: 'reviewer',
    });
    expect(decision.scope).toBe('cross-file');
  });
});

describe('MaintainerBrain.parseFindings Markdown fallback', () => {
  function makeNoCallLlmClient(): LlmClient {
    return {
      complete: vi.fn().mockRejectedValue(new Error('LLM 不应被调用')),
    } as unknown as LlmClient;
  }

  it('Markdown 列表直接解析多条 finding', async () => {
    const brain = new MaintainerBrain({ llmClient: makeNoCallLlmClient() });
    const body = `## 发现项

- \`src/a.ts:10\` · 规则 \`no-any\` 类型不安全
  **修改建议**：使用具体类型
- \`src/b.ts:25\` · 规则 \`unused\` 变量未使用
  **修改建议**：删除变量

---
*生成于 2026/07/07 ...*`;

    const findings = await brain.parseFindings({ body, isSummary: true });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      file: 'src/a.ts',
      line: 10,
      ruleId: 'no-any',
      message: '类型不安全',
      suggestion: '使用具体类型',
    });
    expect(findings[1]).toMatchObject({
      file: 'src/b.ts',
      line: 25,
      ruleId: 'unused',
      message: '变量未使用',
      suggestion: '删除变量',
    });
  });

  it('Agent 签名 footer 不污染解析结果', async () => {
    const brain = new MaintainerBrain({ llmClient: makeNoCallLlmClient() });
    const body = `- \`src/c.ts:5\` 问题\n\n---\n*生成于 ... CodeKeeper Advance*`;
    const findings = await brain.parseFindings({ body });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/c.ts');
  });

  it('无 Markdown finding 时回退 LLM', async () => {
    const llmClient = createMockLlmClient(JSON.stringify([]));
    const brain = new MaintainerBrain({ llmClient });
    const findings = await brain.parseFindings({ body: '这是一个无关评论' });
    expect(findings).toHaveLength(0);
  });

  it('普通文本段落可解析出多个 finding', async () => {
    const llmClient = createMockLlmClient(
      JSON.stringify([
        { severity: 'HIGH', file: 'src/a.ts', line: 10, message: '类型不安全', suggestion: '使用具体类型', autoFixable: true },
        { severity: 'MEDIUM', file: 'src/b.ts', line: 25, message: '变量未使用', suggestion: '删除变量', autoFixable: true },
      ])
    );
    const brain = new MaintainerBrain({ llmClient });
    const findings = await brain.parseFindings({
      body: 'src/a.ts 第 10 行的 any 建议改成具体类型；另外 src/b.ts 第 25 行的变量未使用，建议删除。',
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ file: 'src/a.ts', line: 10, message: '类型不安全' });
    expect(findings[1]).toMatchObject({ file: 'src/b.ts', line: 25, message: '变量未使用' });
  });

  it('LLM 返回 { findings: [...] } 对象也能解析', async () => {
    const llmClient = createMockLlmClient(
      JSON.stringify({
        findings: [{ severity: 'LOW', file: 'src/c.ts', line: 5, message: '小问题', suggestion: '改一下' }],
      })
    );
    const brain = new MaintainerBrain({ llmClient });
    const findings = await brain.parseFindings({ body: '这里有个小问题' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'src/c.ts', line: 5 });
  });

  it('无反引号的 Markdown 列表也能直接解析多条 finding', async () => {
    const brain = new MaintainerBrain({ llmClient: makeNoCallLlmClient() });
    const body = `## 发现项

- src/a.ts:10 类型不安全
  **修改建议**：使用具体类型
- src/b.ts:25 变量未使用
  **修改建议**：删除变量
`;
    const findings = await brain.parseFindings({ body, isSummary: true });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ file: 'src/a.ts', line: 10, message: '类型不安全' });
    expect(findings[1]).toMatchObject({ file: 'src/b.ts', line: 25, message: '变量未使用' });
  });
});

describe('MaintainerBrain.enrichFindingsWithCases', () => {
  function makeMemoryClient(recallResult: string[] = []) {
    return {
      context: { projectId: 'proj-1' },
      recallFindingCase: vi.fn().mockResolvedValue(recallResult),
    } as unknown as NonNullable<
      import('../../../../src/advance/classic/fix/maintainer-brain.js').MaintainerBrainOptions['memoryClient']
    >;
  }

  it('命中 case 时合并字段', async () => {
    const memoryClient = makeMemoryClient([
      '[CASE:case:proj-1:mr-1:src_a.ts:10:no-any]\n规则: no-any\n问题: 类型不安全\n建议: 使用具体类型\n状态: open',
    ]);
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix"}'),
      memoryClient,
    });

    const findings = [
      {
        severity: 'MEDIUM' as const,
        file: 'src/a.ts',
        line: 10,
        ruleId: 'no-any',
        message: '原始描述',
        suggestion: '原始建议',
      },
    ];
    const enriched = await brain.enrichFindingsWithCases(findings, 1);
    expect(enriched[0].message).toBe('类型不安全');
    expect(enriched[0].suggestion).toBe('使用具体类型');
    expect(enriched[0].ruleId).toBe('no-any');
  });

  it('未命中 case 时保持原样', async () => {
    const memoryClient = makeMemoryClient([]);
    const brain = new MaintainerBrain({
      llmClient: createMockLlmClient('{"action":"fix"}'),
      memoryClient,
    });

    const findings = [
      {
        severity: 'MEDIUM' as const,
        file: 'src/a.ts',
        line: 10,
        message: '原始描述',
        suggestion: '原始建议',
      },
    ];
    const enriched = await brain.enrichFindingsWithCases(findings, 1);
    expect(enriched[0].message).toBe('原始描述');
  });

  it('memoryClient 未配置时不抛错', async () => {
    const brain = new MaintainerBrain({ llmClient: createMockLlmClient('{"action":"fix"}') });
    const findings = [
      {
        severity: 'MEDIUM' as const,
        file: 'src/a.ts',
        line: 10,
        message: '原始描述',
        suggestion: '原始建议',
      },
    ];
    const enriched = await brain.enrichFindingsWithCases(findings, 1);
    expect(enriched).toEqual(findings);
  });
});
