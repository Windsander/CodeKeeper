import { describe, it, expect, vi } from 'vitest';
import { CognitiveEngine } from '../../../../src/advance/classic/cognitive-engine.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { CognitiveContext } from '../../../../src/advance/classic/fix/cognitive-types.js';
import type { IMemoryClient } from '../../../../src/advance/classic/memory/types.js';

function makeContext(): CognitiveContext {
  return {
    finding: {
      severity: 'MEDIUM',
      file: 'src/a.ts',
      line: 2,
      message: '变量未使用',
      suggestion: '删除',
      autoFixable: true,
    },
    fileContent: 'const a = 1;\nconst b = 2;\n',
    originalComment: '这里 b 没用到',
    mrContext: {
      iid: 1,
      title: 'Test',
      sourceBranch: 'feat/test',
      targetBranch: 'main',
      description: '',
      diffSummary: '',
      changedFiles: ['src/a.ts'],
    },
    relatedFindings: [],
    recalledMemories: [],
  };
}

function makeLlmClient(response: string): LlmClient {
  return new LlmClient({ apiKey: 'test', mock: { response } });
}

describe('CognitiveEngine', () => {
  it('fast 模式解析 CognitiveDecision', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeLlmClient(
        JSON.stringify({
          action: 'fix',
          reason: '可以删除',
          fixDescription: '删除未使用变量 b',
          scope: 'local',
          analysis: 'b 未使用',
          consideredOptions: ['保留', '删除'],
          reasoning: '删除更干净',
          confidence: 'high',
        })
      ),
    });

    const decision = await engine.decide(makeContext(), 'fast');

    expect(decision.action).toBe('fix');
    expect(decision.analysis).toBe('b 未使用');
    expect(decision.consideredOptions).toEqual(['保留', '删除']);
    expect(decision.reasoning).toBe('删除更干净');
    expect(decision.confidence).toBe('high');
  });

  it('fast 模式默认返回 standard', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeLlmClient(
        JSON.stringify({
          action: 'fix',
          reason: '可以删除',
          analysis: '分析',
          consideredOptions: [],
          reasoning: '理由',
          confidence: 'medium',
        })
      ),
    });

    const decision = await engine.decide(makeContext());

    expect(decision.action).toBe('fix');
  });

  it('standard 模式经过 Inquiry + Options + Decide 三步', async () => {
    let callCount = 0;
    const responses = [
      JSON.stringify({
        needsMoreContext: true,
        queries: [{ type: 'project_knowledge', target: 'unused variable convention' }],
        reason: '需要确认项目约定',
      }),
      JSON.stringify({
        options: [
          { description: '删除变量', pros: ['干净'], cons: [], risk: 'low' },
          { description: '保留注释', pros: ['安全'], cons: ['残留'], risk: 'low' },
        ],
      }),
      JSON.stringify({
        action: 'fix',
        reason: '删除',
        fixDescription: '删除未使用变量',
        analysis: 'b 未使用',
        consideredOptions: ['删除变量', '保留注释'],
        reasoning: '删除更干净',
        confidence: 'high',
      }),
    ];

    const complete = vi.fn().mockImplementation(async () => {
      return responses[callCount++] ?? '{}';
    });
    const llmClient = {
      complete,
      completeJson: complete,
    } as unknown as LlmClient;

    const recallPlanner = {
      plan: vi.fn().mockResolvedValue({
        needsRecall: true,
        queries: [{ type: 'project_knowledge', query: 'unused variable convention' }],
      }),
      execute: vi.fn().mockResolvedValue(['项目约定：未使用变量应删除']),
    };

    const engine = new CognitiveEngine({ llmClient, recallPlanner: recallPlanner as unknown as import('../../../../src/advance/classic/memory/recall-planner.js').RecallPlanner });
    const decision = await engine.decide(makeContext(), 'standard');

    expect(decision.action).toBe('fix');
    expect(decision.analysis).toBe('b 未使用');
    expect(llmClient.complete).toHaveBeenCalledTimes(3);
  });

  it('reflect 生成反思并关联 case key', async () => {
    const recorded: Array<{ caseKey: string; reflection: string; outcome: 'success' | 'failure' }> = [];
    const memoryClient = {
      context: { projectId: 'p1' },
      recordReflection: vi.fn().mockImplementation(async (input) => {
        recorded.push(input);
      }),
    } as unknown as IMemoryClient;

    const engine = new CognitiveEngine({
      llmClient: makeLlmClient('下次遇到未使用变量应优先删除，保持代码干净。'),
      memoryClient,
    });

    const reflection = await engine.reflect(makeContext(), 'success', '删除未使用变量 b');

    expect(reflection).toContain('未使用变量');
    expect(memoryClient.recordReflection).toHaveBeenCalled();
    expect(recorded[0].caseKey).toContain('mr-1');
  });
});
