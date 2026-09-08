import { describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { LlmMaintainerLocalJudge } from '../../../../src/advance/classic/fix/maintainer-llm-judge.js';
import { mockOf } from '../../../helpers/mock-of.js';

function createJudge(
  completeJsonImpl: (...args: unknown[]) => Promise<string>
): LlmMaintainerLocalJudge {
  const llmClient = mockOf<LlmClient>({
    completeJson: vi.fn().mockImplementation(completeJsonImpl),
  });
  return new LlmMaintainerLocalJudge(llmClient);
}

describe('LlmMaintainerLocalJudge', () => {
  it('最终决策红队复核会同时检查候选方案、既有意见和主决策回应', async () => {
    const llmClient = new LlmClient({ apiKey: 'test', mock: { response: '{}' } });
    const completeJson = vi.spyOn(llmClient, 'completeJson').mockResolvedValue(
      JSON.stringify({
        approve: false,
        concerns: ['仍未证明所有调用点都已覆盖'],
        requiredChanges: ['补充调用点审计证据'],
        reason: '最终决策仍有验证缺口',
      })
    );
    const judge = new LlmMaintainerLocalJudge(llmClient);

    const result = await judge.adversarialDecisionReview(
      'src/service.ts:12\n返回值处理不完整',
      '候选方案：补齐错误分支\n方案红队意见：必须核对所有调用点',
      '{"action":"fix","adversarialResponses":["已检查调用点"]}',
      'function run() { return execute(); }'
    );

    expect(result).toEqual({
      kind: 'reliable',
      approve: false,
      concerns: ['仍未证明所有调用点都已覆盖'],
      requiredChanges: ['补充调用点审计证据'],
      reason: '最终决策仍有验证缺口',
    });
    expect(completeJson.mock.calls[0]?.[0]).toContain('必须核对所有调用点');
    expect(completeJson.mock.calls[0]?.[0]).toContain('adversarialResponses');
    expect(completeJson.mock.calls[0]?.[1]).toContain('独立红队验收员');
  });

  describe('isAvailable', () => {
    it('始终返回 true', () => {
      const judge = createJudge(vi.fn());
      expect(judge.isAvailable()).toBe(true);
    });
  });

  describe('assistAlreadyFixedCheck', () => {
    it('LLM 判定已修复时返回 reliable + likelyAlreadyFixed=true', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({
            likelyAlreadyFixed: true,
            reason: '该问题在当前代码中已不存在',
            evidence: 'function foo() { return fixed; }',
          })
        )
      );

      const result = await judge.assistAlreadyFixedCheck('变量未使用', 'const x = 1;');

      expect(result.kind).toBe('reliable');
      if (result.kind === 'reliable') {
        expect(result.likelyAlreadyFixed).toBe(true);
        expect(result.reason).toBe('该问题在当前代码中已不存在');
        expect(result.evidence).toBe('function foo() { return fixed; }');
      }
    });

    it('LLM 判定未修复时返回 reliable + likelyAlreadyFixed=false', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ likelyAlreadyFixed: false, reason: '问题仍然存在' })
        )
      );

      const result = await judge.assistAlreadyFixedCheck('变量未使用');

      expect(result.kind).toBe('reliable');
      if (result.kind === 'reliable') {
        expect(result.likelyAlreadyFixed).toBe(false);
      }
    });

    it('LLM 返回无效 JSON 时返回 unreliable', async () => {
      const judge = createJudge(vi.fn().mockResolvedValue('not json'));

      const result = await judge.assistAlreadyFixedCheck('test');

      expect(result.kind).toBe('unreliable');
      if (result.kind === 'unreliable') {
        expect(result.reason).toContain('不可解析');
      }
    });

    it('LLM 返回缺少必需字段时返回 unreliable', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(JSON.stringify({ reason: 'no boolean field' }))
      );

      const result = await judge.assistAlreadyFixedCheck('test');

      expect(result.kind).toBe('unreliable');
    });

    it('LLM 调用抛异常时返回 unreliable', async () => {
      const judge = createJudge(vi.fn().mockRejectedValue(new Error('API rate limit')));

      const result = await judge.assistAlreadyFixedCheck('test');

      expect(result.kind).toBe('unreliable');
      if (result.kind === 'unreliable') {
        expect(result.reason).toContain('API rate limit');
      }
    });
  });

  describe('reassessSemanticIdentity', () => {
    it('LLM 判定同一语义问题时返回 likelySame=true', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({
            likelySame: true,
            confidence: 'high',
            reason: '描述的是同一个变量未使用问题',
          })
        )
      );

      const result = await judge.reassessSemanticIdentity(
        '变量 x 未使用',
        'ignore: 已处理变量未使用'
      );

      // SemanticReidentificationResult 无 kind 字段
      expect('likelySame' in result && result.likelySame).toBe(true);
      if ('likelySame' in result) {
        expect(result.confidence).toBe('high');
      }
    });

    it('LLM 判定不同语义问题时返回 likelySame=false', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ likelySame: false, confidence: 'medium', reason: '不同的问题' })
        )
      );

      const result = await judge.reassessSemanticIdentity(
        '缺少错误处理',
        'ignore: 已处理变量未使用'
      );

      if ('likelySame' in result) {
        expect(result.likelySame).toBe(false);
        expect(result.confidence).toBe('medium');
      }
    });

    it('confidence 值非法时回退为 low', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ likelySame: true, confidence: 'invalid', reason: 'test' })
        )
      );

      const result = await judge.reassessSemanticIdentity('desc', 'prev');

      if ('likelySame' in result) {
        expect(result.confidence).toBe('low');
      }
    });

    it('LLM 调用失败时返回 unreliable', async () => {
      const judge = createJudge(vi.fn().mockRejectedValue(new Error('network error')));

      const result = await judge.reassessSemanticIdentity('desc', 'prev');

      expect('kind' in result && result.kind === 'unreliable').toBe(true);
    });
  });

  describe('adviseOnStuckProgress', () => {
    it('LLM 建议继续时返回 suggestion=continue', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ suggestion: 'continue', suggestStop: false, reason: '方向正确' })
        )
      );

      const result = await judge.adviseOnStuckProgress('修复变量未使用', '已尝试两种方法');

      // StuckCorrectionResult 无 kind 字段
      if ('suggestion' in result) {
        expect(result.suggestion).toBe('continue');
        expect(result.suggestStop).toBe(false);
      }
    });

    it('LLM 建议停止时返回 suggestion=stop + suggestStop=true', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ suggestion: 'stop', suggestStop: true, reason: '信息不足' })
        )
      );

      const result = await judge.adviseOnStuckProgress('模糊的描述', '多次尝试无进展');

      if ('suggestion' in result) {
        expect(result.suggestion).toBe('stop');
        expect(result.suggestStop).toBe(true);
      }
    });

    it('LLM 返回无效 suggestion 时返回 unreliable', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ suggestion: 'invalid_action', suggestStop: false, reason: 'test' })
        )
      );

      const result = await judge.adviseOnStuckProgress('desc', 'progress');

      expect('kind' in result && result.kind === 'unreliable').toBe(true);
    });
  });

  describe('preFilterScope', () => {
    it('LLM 判定 trivial 时返回 reliable + scope=trivial', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(JSON.stringify({ scope: 'trivial', reason: '单行注释修改' }))
      );

      const result = await judge.preFilterScope('缺少注释', 'src/a.ts', 10);

      expect(result.kind).toBe('reliable');
      if (result.kind === 'reliable') {
        expect(result.scope).toBe('trivial');
      }
    });

    it('LLM 判定 cross-file 时返回 reliable + scope=cross-file', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(JSON.stringify({ scope: 'cross-file', reason: '涉及接口变更' }))
      );

      const result = await judge.preFilterScope('接口签名变更');

      expect(result.kind).toBe('reliable');
      if (result.kind === 'reliable') {
        expect(result.scope).toBe('cross-file');
      }
    });

    it('LLM 返回无效 scope 值时返回 unreliable', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(JSON.stringify({ scope: 'invalid', reason: 'test' }))
      );

      const result = await judge.preFilterScope('test');

      expect(result.kind).toBe('unreliable');
      if (result.kind === 'unreliable') {
        expect(result.reason).toContain('无效的 scope 值');
      }
    });
  });

  describe('preFilterNonFindingDiscussion', () => {
    it('LLM 判定非 finding 时返回 reliable + isProbablyNonFinding=true', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ isProbablyNonFinding: true, reason: '纯统计汇总' })
        )
      );

      const result = await judge.preFilterNonFindingDiscussion('本次扫描共发现 100 个问题', 1);

      expect(result.kind).toBe('reliable');
      if (result.kind === 'reliable') {
        expect(result.isProbablyNonFinding).toBe(true);
      }
    });

    it('LLM 判定是 finding 时返回 reliable + isProbablyNonFinding=false', async () => {
      const judge = createJudge(
        vi.fn().mockResolvedValue(
          JSON.stringify({ isProbablyNonFinding: false, reason: '指向具体代码问题' })
        )
      );

      const result = await judge.preFilterNonFindingDiscussion('src/a.ts:10 变量未使用');

      expect(result.kind).toBe('reliable');
      if (result.kind === 'reliable') {
        expect(result.isProbablyNonFinding).toBe(false);
      }
    });

    it('LLM 调用失败时返回 unreliable', async () => {
      const judge = createJudge(vi.fn().mockRejectedValue(new Error('timeout')));

      const result = await judge.preFilterNonFindingDiscussion('body');

      expect(result.kind).toBe('unreliable');
    });
  });
});
