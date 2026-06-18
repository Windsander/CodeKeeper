import { describe, it, expect } from 'vitest';
import { FixDecisionEngine } from '../../../../src/advance/classic/fix/fix-decision-engine.js';
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

describe('FixDecisionEngine', () => {
  it('autoFixable finding 默认 fix', () => {
    const engine = new FixDecisionEngine();
    const decision = engine.decide(makeFinding({ autoFixable: true }));
    expect(decision.action).toBe('fix');
  });

  it('可关闭 autoFixable 自动修复', () => {
    const engine = new FixDecisionEngine({ autoFixAutoFixable: false });
    const decision = engine.decide(makeFinding({ autoFixable: true }));
    expect(decision.action).toBe('skip');
  });

  it('非 autoFixable 的 HIGH severity 建议 defer', () => {
    const engine = new FixDecisionEngine();
    const decision = engine.decide(makeFinding({ severity: 'HIGH' }));
    expect(decision.action).toBe('defer');
  });

  it('非 autoFixable 的 MEDIUM severity 跳过', () => {
    const engine = new FixDecisionEngine();
    const decision = engine.decide(makeFinding({ severity: 'MEDIUM' }));
    expect(decision.action).toBe('skip');
  });
});
