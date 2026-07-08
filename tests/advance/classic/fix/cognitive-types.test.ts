import { describe, it, expect } from 'vitest';
import type { CognitiveDecision, CognitiveContext } from '../../../../src/advance/classic/fix/cognitive-types.js';

describe('cognitive-types', () => {
  it('CognitiveDecision 包含 reasoning 字段', () => {
    const d: CognitiveDecision = {
      action: 'fix',
      reason: '测试',
      analysis: '分析',
      consideredOptions: [],
      reasoning: '因为...',
      confidence: 'high',
    };
    expect(d.reasoning).toBe('因为...');
  });

  it('CognitiveContext 可以正确组装', () => {
    const ctx: CognitiveContext = {
      finding: {
        severity: 'MEDIUM',
        file: 'src/a.ts',
        line: 2,
        message: '变量未使用',
        suggestion: '删除',
        autoFixable: true,
      },
      fileContent: 'const a = 1;\n',
      originalComment: '这里有个未使用变量',
      mrContext: {
        iid: 1,
        title: 'Test',
        sourceBranch: 'feat/test',
        targetBranch: 'main',
        description: '',
        diffSummary: 'src/a.ts: +1/-0',
        changedFiles: ['src/a.ts'],
      },
      relatedFindings: [],
      recalledMemories: [],
    };
    expect(ctx.mrContext.iid).toBe(1);
  });
});
