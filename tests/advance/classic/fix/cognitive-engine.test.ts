import { describe, it, expect, vi } from 'vitest';
import {
  CognitiveEngine,
  isAlreadyFixedEvidenceGrounded,
} from '../../../../src/advance/classic/cognitive-engine.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { CognitiveContext } from '../../../../src/advance/classic/fix/cognitive-types.js';
import type { IMemoryClient } from '../../../../src/advance/classic/memory/types.js';
import type { RecallPlanner } from '../../../../src/advance/classic/memory/recall-planner.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { MaintainerLocalJudge } from '../../../../src/advance/classic/fix/maintainer-local-judge.js';
import { mockOf } from '../../../helpers/mock-of.js';

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

function makeFastLlmClient(
  input: Record<string, unknown>,
  alreadyFixedInput: Record<string, unknown> = {
    alreadyFixed: false,
    reason: '问题仍存在',
  }
): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: {
      toolResponses: [
        { toolCalls: [{ id: '0', name: 'already_fixed_check', input: alreadyFixedInput }] },
        { toolCalls: [{ id: '1', name: 'fast_decision', input }] },
      ],
    },
  });
}

function makeAlreadyFixedLlmClient(alreadyFixed: boolean): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: {
      toolResponses: [
        {
          toolCalls: [
            {
              id: '1',
              name: 'already_fixed_check',
              input: {
                alreadyFixed,
                reason: alreadyFixed ? 'error 字段已存在' : 'error 字段缺失',
                evidence: alreadyFixed ? '第 5 行已包含 error?: number' : undefined,
              },
            },
          ],
        },
      ],
    },
  });
}

describe('isAlreadyFixedEvidenceGrounded', () => {
  it('拒绝引用其他 finding 函数的错位代码证据', () => {
    expect(
      isAlreadyFixedEvidenceGrounded({
        findingFile: 'src/a.ts',
        fileContent: 'export function targetFunction() { return true; }',
        evidence: '`otherFunction` 已经包含所需保护',
      })
    ).toBe(false);
    expect(
      isAlreadyFixedEvidenceGrounded({
        findingFile: 'src/a.ts',
        fileContent: 'export function targetFunction() { return true; }',
        evidence: '`targetFunction` 已经包含所需保护',
      })
    ).toBe(true);
    expect(
      isAlreadyFixedEvidenceGrounded({
        findingFile: 'src/a.ts',
        fileContent: 'export function targetFunction() { return true; }',
        evidence: 'otherFunction 已经包含所需保护',
      })
    ).toBe(false);
    expect(
      isAlreadyFixedEvidenceGrounded({
        findingFile: 'src/feature/index.ts',
        fileContent: 'export function targetFunction() { return true; }',
        evidence: 'src/other/index.ts 中已包含所需保护',
      })
    ).toBe(false);
  });
});

describe('CognitiveEngine', () => {
  it('fast 模式解析 CognitiveDecision', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeFastLlmClient({
        action: 'fix',
        reason: '可以删除',
        fixDescription: '删除未使用变量 b',
        scope: 'local',
        analysis: 'b 未使用',
        consideredOptions: ['保留', '删除'],
        reasoning: '删除更干净',
        confidence: 'high',
      }),
    });

    const decision = await engine.decide(makeContext(), 'fast');

    expect(decision.action).toBe('fix');
    expect(decision.analysis).toBe('b 未使用');
    expect(decision.consideredOptions).toEqual(['保留', '删除']);
    expect(decision.reasoning).toBe('删除更干净');
    expect(decision.confidence).toBe('high');
  });

  it('fast 模式返回 fix 决策', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeFastLlmClient({
        action: 'fix',
        reason: '可以删除',
        analysis: '分析',
        consideredOptions: [],
        reasoning: '理由',
        confidence: 'medium',
      }),
    });

    const decision = await engine.decide(makeContext(), 'fast');

    expect(decision.action).toBe('fix');
  });

  it('fast 模式先执行 already-fixed 复查，已修复时不再进入修复决策', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: true,
                  reason: '当前代码已经包含要求的字段',
                  evidence: '当前代码包含 error?: number',
                  evidenceSnippet: 'error?: number',
                },
              },
            ],
          },
        ],
      },
    });
    const completeDecision = vi.spyOn(llmClient, 'completeDecision');
    const baseContext = makeContext();
    const context = {
      ...baseContext,
      finding: {
        ...baseContext.finding,
        message: '接口缺少 error 字段',
        suggestion: '添加 error 字段',
      },
      fileContent: 'interface Result { error?: number; }',
    };

    const decision = await new CognitiveEngine({ llmClient }).decide(context, 'fast');

    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(completeDecision).toHaveBeenCalledTimes(1);
    expect(completeDecision.mock.calls[0]?.[0][0]?.name).toBe('already_fixed_check');
  });

  it('standard 模式经过 already-fixed 复查 + Inquiry + Options + Decide 四步', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: { alreadyFixed: false, reason: '变量 b 仍存在且未使用' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'inquiry_decision',
                input: {
                  needsMoreContext: true,
                  queries: [{ type: 'project_knowledge', target: 'unused variable convention' }],
                  reason: '需要确认项目约定',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'already_fixed_check',
                input: { alreadyFixed: false, reason: '变量 b 仍存在且未使用' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '4',
                name: 'options_decision',
                input: {
                  options: [
                    { description: '删除变量', pros: ['干净'], cons: [], risk: 'low' },
                    { description: '保留注释', pros: ['安全'], cons: ['残留'], risk: 'low' },
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '5',
                name: 'final_decision',
                input: {
                  action: 'fix',
                  reason: '删除',
                  fixDescription: '删除未使用变量',
                  analysis: 'b 未使用',
                  consideredOptions: ['删除变量', '保留注释'],
                  reasoning: '删除更干净',
                  confidence: 'high',
                },
              },
            ],
          },
        ],
      },
    });

    const recallPlanner = mockOf<RecallPlanner>({
      plan: vi.fn().mockResolvedValue({
        needsRecall: true,
        queries: [{ type: 'project_knowledge', query: 'unused variable convention' }],
      }),
      execute: vi.fn().mockResolvedValue(['项目约定：未使用变量应删除']),
    });

    const completeDecision = vi.spyOn(llmClient, 'completeDecision');
    const engine = new CognitiveEngine({ llmClient, recallPlanner });
    const decision = await engine.decide(makeContext(), 'standard');

    expect(decision.action).toBe('fix');
    expect(decision.analysis).toBe('b 未使用');
    expect(completeDecision.mock.calls[4]?.[1]).toContain('const b = 2;');
  });

  it('fast 模式返回 alreadyFixed ignore 决策', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeFastLlmClient({
        action: 'ignore',
        reason: '变量 b 已被删除',
        analysis: '当前代码中 b 已不存在',
        consideredOptions: [],
        reasoning: '问题已修复',
        confidence: 'high',
        alreadyFixed: true,
        replyBody: '该未使用变量已在之前的提交中删除，当前代码无需再改。',
      }),
    });

    const decision = await engine.decide(makeContext(), 'fast');

    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(decision.replyBody).toContain('删除');
  });

  it('standard 模式检测到问题已修复时返回 ignore', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeAlreadyFixedLlmClient(true),
    });

    const decision = await engine.decide(makeContext(), 'standard');

    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(decision.replyBody).toContain('第 5 行');
  });

  it('standard 模式检测到问题未修复时继续生成修复方案', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: false,
                  reason: 'error 字段缺失',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'inquiry_decision',
                input: { needsMoreContext: false, queries: [], reason: '无需补充上下文' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'options_decision',
                input: {
                  options: [
                    {
                      description: '添加 error 字段',
                      pros: ['修复类型错误'],
                      cons: [],
                      risk: 'low',
                    },
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '4',
                name: 'final_decision',
                input: {
                  action: 'fix',
                  reason: '添加 error 字段',
                  analysis: '分析',
                  consideredOptions: [],
                  reasoning: '理由',
                  confidence: 'high',
                },
              },
            ],
          },
        ],
      },
    });

    const engine = new CognitiveEngine({ llmClient });
    const decision = await engine.decide(makeContext(), 'standard');

    expect(decision.action).toBe('fix');
  });

  it('最终决策未通过红队复核时允许修订一次，复核通过后才允许 fix', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: { alreadyFixed: false, reason: '问题仍存在' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'inquiry_decision',
                input: { needsMoreContext: false, queries: [], reason: '当前上下文足够' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'options_decision',
                input: {
                  options: [
                    {
                      description: '修复目标函数',
                      pros: ['改动集中'],
                      cons: ['需要确认调用点'],
                      risk: 'medium',
                      verificationSteps: ['运行目标模块测试'],
                    },
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '4',
                name: 'final_decision',
                input: {
                  action: 'fix',
                  reason: '可以修复',
                  fixDescription: '修复目标函数',
                  analysis: '根因已定位',
                  reasoning: '方案改动集中',
                  confidence: 'high',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '5',
                name: 'final_decision',
                input: {
                  action: 'fix',
                  reason: '已逐项处理红队意见',
                  fixDescription: '修复目标函数并检查调用点',
                  analysis: '根因已定位且影响范围已核对',
                  reasoning: '保留最小改动，同时完成调用点审计',
                  confidence: 'high',
                  verificationPlan: ['运行目标模块测试', '检查所有调用点'],
                  adversarialResponses: [
                    '可能遗漏调用点：已搜索并检查所有调用点',
                    '必须确认调用点：已完成调用点审计并纳入验证',
                    '验证计划未覆盖回归场景：已补充目标模块测试',
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const localJudge = mockOf<MaintainerLocalJudge>({
      isAvailable: vi.fn().mockReturnValue(true),
      adversarialReview: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'reliable',
          approve: false,
          concerns: ['可能遗漏调用点'],
          requiredChanges: ['必须确认调用点'],
          reason: '候选方案尚未证明影响范围完整',
        })
        .mockResolvedValueOnce({
          kind: 'reliable',
          approve: false,
          concerns: ['验证计划未覆盖回归场景'],
          requiredChanges: [],
          reason: '需要补充行为回归验证',
        }),
      adversarialDecisionReview: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'reliable',
          approve: false,
          concerns: ['最终决策没有说明如何验证所有调用点'],
          requiredChanges: ['补充调用点审计的可执行验证'],
          reason: '主决策尚未闭环影响范围',
        })
        .mockResolvedValueOnce({
          kind: 'reliable',
          approve: true,
          concerns: [],
          requiredChanges: [],
          reason: '修订后的决策已形成可执行闭环',
        }),
    });
    const completeDecision = vi.spyOn(llmClient, 'completeDecision');

    const decision = await new CognitiveEngine({ llmClient, localJudge }).decide(
      makeContext(),
      'deep'
    );

    expect(decision.action).toBe('fix');
    expect(decision.verificationPlan).toEqual(['运行目标模块测试', '检查所有调用点']);
    expect(decision.adversarialConcerns).toContain('最终决策没有说明如何验证所有调用点');
    expect(decision.adversarialConcerns).toContain('验证计划未覆盖回归场景');
    expect(decision.adversarialResponses).toEqual([
      '可能遗漏调用点：已搜索并检查所有调用点',
      '必须确认调用点：已完成调用点审计并纳入验证',
      '验证计划未覆盖回归场景：已补充目标模块测试',
    ]);
    expect(localJudge.adversarialReview).toHaveBeenCalledTimes(2);
    expect(localJudge.adversarialDecisionReview).toHaveBeenCalledTimes(2);
    expect(completeDecision).toHaveBeenCalledTimes(5);
    expect(completeDecision.mock.calls[4]?.[1]).toContain('上一版最终决策未通过独立红队复核');
  });

  it('红队意见经过一次修订仍未闭环时降级为 ask', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: { alreadyFixed: false, reason: '问题仍存在' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'inquiry_decision',
                input: { needsMoreContext: false, queries: [], reason: '上下文足够' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'options_decision',
                input: { options: [{ description: '局部修改', pros: [], cons: [], risk: 'low' }] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '4',
                name: 'final_decision',
                input: { action: 'fix', reason: '直接修改', verificationPlan: [] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '5',
                name: 'final_decision',
                input: { action: 'fix', reason: '仍然认为可以修改', verificationPlan: [] },
              },
            ],
          },
        ],
      },
    });
    const localJudge = mockOf<MaintainerLocalJudge>({
      isAvailable: vi.fn().mockReturnValue(true),
      adversarialReview: vi.fn().mockResolvedValue({
        kind: 'reliable',
        approve: false,
        concerns: ['未证明根因已经解决'],
        requiredChanges: [],
        reason: '缺少根因证据',
      }),
      adversarialDecisionReview: vi.fn().mockResolvedValue({
        kind: 'reliable',
        approve: false,
        concerns: ['最终决策仍未给出根因证据'],
        requiredChanges: ['提供当前代码证据和可执行验证'],
        reason: '最终决策仍未闭环',
      }),
    });

    const decision = await new CognitiveEngine({ llmClient, localJudge }).decide(
      makeContext(),
      'standard'
    );

    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain('独立红队复核');
    expect(localJudge.adversarialDecisionReview).toHaveBeenCalledTimes(2);
  });

  it('最终决策红队复核不可靠时直接 ask，不浪费一次主模型修订', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: { alreadyFixed: false, reason: '问题仍存在' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'inquiry_decision',
                input: { needsMoreContext: false, queries: [], reason: '上下文足够' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'options_decision',
                input: { options: [{ description: '局部修改', pros: [], cons: [], risk: 'low' }] },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '4',
                name: 'final_decision',
                input: { action: 'fix', reason: '可以修改', verificationPlan: ['运行目标测试'] },
              },
            ],
          },
        ],
      },
    });
    const localJudge = mockOf<MaintainerLocalJudge>({
      isAvailable: vi.fn().mockReturnValue(true),
      adversarialReview: vi.fn().mockResolvedValue({
        kind: 'reliable',
        approve: true,
        concerns: [],
        requiredChanges: [],
        reason: '候选方案可进入最终决策',
      }),
      adversarialDecisionReview: vi.fn().mockResolvedValue({
        kind: 'unreliable',
        reason: '红队模型暂时不可用',
      }),
    });
    const completeDecision = vi.spyOn(llmClient, 'completeDecision');

    const decision = await new CognitiveEngine({ llmClient, localJudge }).decide(
      makeContext(),
      'standard'
    );

    expect(decision.action).toBe('ask');
    expect(decision.reason).toContain('未能完成可靠的独立红队复核');
    expect(decision.adversarialConcerns).toContain('在执行修复前重新完成独立红队复核');
    expect(completeDecision).toHaveBeenCalledTimes(4);
  });

  it('standard 模式聚焦窗口不足时会读取完整文件复核 alreadyFixed', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: false,
                  reason: '聚焦窗口看不到相关类型定义',
                  needsMoreContext: true,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: true,
                  reason: '完整文件中第 10 行已定义 error 字段',
                  evidence: '第 10 行已包含 error?: number',
                  evidenceSnippet: 'error?: number',
                },
              },
            ],
          },
        ],
      },
    });

    const worktreeManager = mockOf<WorktreeManager>({
      resolveFilePath: vi.fn().mockResolvedValue('src/a.ts'),
      readFile: vi.fn().mockResolvedValue('interface Result { error?: number; }\n'),
    });

    const engine = new CognitiveEngine({ llmClient, worktreeManager });
    const decision = await engine.decide(makeContext(), 'standard');

    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(decision.replyBody).toContain('第 10 行已包含 error?: number');
  });

  it('历史 finding 即使聚焦检查不要求更多上下文也会读取完整文件复核', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: false,
                  reason: '旧行号附近仍像是缺少默认 sink 测试',
                  needsMoreContext: false,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: true,
                  reason: '当前完整文件已经覆盖默认 sink 路径',
                  evidence: '完整文件中存在未注入 tracker 时不抛异常的测试',
                },
              },
            ],
          },
        ],
      },
    });
    const readFile = vi.fn().mockResolvedValue('完整文件中存在默认 sink 测试');
    const worktreeManager = mockOf<WorktreeManager>({
      resolveFilePath: vi.fn().mockResolvedValue('src/a.ts'),
      readFile,
    });
    const context = makeContext();
    context.staleFinding = true;

    const engine = new CognitiveEngine({ llmClient, worktreeManager });
    const decision = await engine.decide(context, 'standard');

    expect(readFile).toHaveBeenCalledWith('src/a.ts');
    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(decision.replyBody).toContain('完整文件中存在未注入 tracker 时不抛异常的测试');
  });

  it('cross-file finding can enrich already-fixed checks with workspace search results', async () => {
    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          {
            toolCalls: [
              {
                id: '1',
                name: 'already_fixed_check',
                input: { alreadyFixed: false, reason: '需要检查关联清理路径' },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '2',
                name: 'inquiry_decision',
                input: {
                  needsMoreContext: true,
                  queries: [{ type: 'workspace_search', target: 'dispose' }],
                  reason: 'the cleanup method may live in another file',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                id: '3',
                name: 'already_fixed_check',
                input: {
                  alreadyFixed: true,
                  reason: 'the facade cleanup now resets the dependency',
                  evidence: 'src/facade.ts:30 calls facade.dispose()',
                },
              },
            ],
          },
        ],
      },
    });
    const searchWorkspace = vi
      .fn()
      .mockResolvedValue([{ file: 'src/facade.ts', line: 30, content: 'facade.dispose();' }]);
    const worktreeManager = mockOf<WorktreeManager>({ searchWorkspace });

    const engine = new CognitiveEngine({ llmClient, worktreeManager });
    const decision = await engine.decide(makeContext(), 'standard');

    expect(searchWorkspace).toHaveBeenCalledWith('dispose');
    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(decision.replyBody).toContain('src/facade.ts:30');
  });

  it('fast 模式返回 alreadyFixed=true 但 action=fix 时归一化为 ignore', async () => {
    const engine = new CognitiveEngine({
      llmClient: makeFastLlmClient({
        action: 'fix',
        reason: '字段已存在',
        alreadyFixed: true,
        replyBody: '当前代码已包含 error 字段',
      }),
    });

    const decision = await engine.decide(makeContext(), 'fast');

    expect(decision.action).toBe('ignore');
    expect(decision.alreadyFixed).toBe(true);
    expect(decision.replyBody).toContain('error 字段');
  });

  it('reflect 生成反思并关联 case key', async () => {
    const recorded: Array<{ caseKey: string; reflection: string; outcome: 'success' | 'failure' }> =
      [];
    const memoryClient = mockOf<IMemoryClient>({
      context: { projectId: 'p1' },
      recordReflection: vi.fn().mockImplementation(async input => {
        recorded.push(input);
      }),
    });

    const engine = new CognitiveEngine({
      llmClient: new LlmClient({
        apiKey: 'test',
        mock: { response: '下次遇到未使用变量应优先删除，保持代码干净。' },
      }),
      memoryClient,
    });

    const reflection = await engine.reflect(makeContext(), 'success', '删除未使用变量 b');

    expect(reflection).toContain('未使用变量');
    expect(memoryClient.recordReflection).toHaveBeenCalled();
    expect(recorded[0].caseKey).toContain('mr-1');
  });
});
