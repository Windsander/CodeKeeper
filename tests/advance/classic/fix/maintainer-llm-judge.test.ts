import { describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { LlmMaintainerLocalJudge } from '../../../../src/advance/classic/fix/maintainer-llm-judge.js';

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
});
