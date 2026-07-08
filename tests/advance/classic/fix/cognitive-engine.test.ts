import { describe, it, expect } from 'vitest';
import { CognitiveEngine } from '../../../../src/advance/classic/cognitive-engine.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { CognitiveContext } from '../../../../src/advance/classic/fix/cognitive-types.js';

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
});
