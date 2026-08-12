import { describe, it, expect, vi } from 'vitest';
import {
  MaintainerRunner,
  buildSummaryStateHash,
  classifyBatchFixItems,
  getDiscussionDeliveryInvalidationReason,
  hasHeadChangedSinceProcessing,
  repairLegacyMaintainerThreadState,
  refreshDiscussionProcessedHeadSha,
  runDiscussionTasks,
  type CiHandlingResult,
} from '../../../../src/advance/classic/runners/maintainer-runner.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type {
  MergeRequest,
  Discussion,
  ReviewFinding,
} from '../../../../src/advance/classic/provider/types.js';
import type { GitLabProvider } from '../../../../src/advance/classic/provider/gitlab-provider.js';
import type { MaintainerBrain } from '../../../../src/advance/classic/fix/maintainer-brain.js';
import type { MaintainerActor } from '../../../../src/advance/classic/fix/maintainer-actor.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { MemoryClient } from '../../../../src/advance/classic/memory/memory-client.js';
import type { MaintainerConfig } from '../../../../src/advance/types.js';
import {
  createLifecycleState,
  type MrLifecycleState,
} from '../../../../src/advance/classic/runners/shared/mr-lifecycle.js';
import type {
  MaintainerThreadState,
  MrAgentState,
} from '../../../../src/advance/classic/runners/shared/state-utils.js';
import { mockOf } from '../../../helpers/mock-of.js';

function makeLlmClient(): LlmClient {
  return new LlmClient({ apiKey: 'test', mock: { response: '' } });
}

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test MR',
  description: 'desc',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  author: 'dev',
  draft: false,
  changesCount: 1,
  createdAt: '',
  updatedAt: '',
  webUrl: '',
};

const mockDiscussion: Discussion = {
  id: 'd-1',
  resolvable: true,
  resolved: false,
  notes: [
    {
      id: 1,
      author: 'reviewer',
      body: 'src/index.ts:2 变量未使用',
      createdAt: '2026-07-08T00:00:00Z',
      resolved: false,
    },
  ],
};

describe('runDiscussionTasks', () => {
  it('单条 discussion 异常不会阻断后续 discussion', async () => {
    const processed: string[] = [];
    const errors: string[] = [];

    await runDiscussionTasks(
      ['first', 'second', 'third'],
      async item => {
        processed.push(item);
        if (item === 'second') throw new Error('second discussion failed');
      },
      (item, error) => {
        errors.push(`${item}:${error instanceof Error ? error.message : String(error)}`);
      }
    );

    expect(processed).toEqual(['first', 'second', 'third']);
    expect(errors).toEqual(['second:second discussion failed']);
  });
});

describe('buildSummaryStateHash', () => {
  it('忽略动态说明变化，避免同一处理状态重复发布汇总', () => {
    const firstHash = buildSummaryStateHash(
      ['src/app.ts:10'],
      ['packages/example-core/src/parser.ts:22 — 第一次修复失败'],
      [{ fileLine: 'src/app.ts:14' }],
      [{ fileLine: 'src/app.ts:18' }],
      [{ fileLine: 'src/app.ts:20' }]
    );
    const secondHash = buildSummaryStateHash(
      ['src/app.ts:10'],
      ['packages/example-core/src/parser.ts:22 — 第二次修复失败，原因不同'],
      [{ fileLine: 'src/app.ts:14' }],
      [{ fileLine: 'src/app.ts:18' }],
      [{ fileLine: 'src/app.ts:20' }]
    );

    expect(secondHash).toBe(firstHash);
  });

  it('处理状态类别变化时生成不同哈希', () => {
    const ignoredHash = buildSummaryStateHash([], [], [], [{ fileLine: 'src/app.ts:10' }], []);
    const fixedHash = buildSummaryStateHash(['src/app.ts:10'], [], [], [], []);

    expect(fixedHash).not.toBe(ignoredHash);
  });

  it('重复结果不会改变汇总哈希', () => {
    const singleHash = buildSummaryStateHash(['src/example.ts:10'], [], [], [], []);
    const duplicateHash = buildSummaryStateHash(
      ['src/example.ts:10', 'src/example.ts:10'],
      [],
      [],
      [],
      []
    );

    expect(duplicateHash).toBe(singleHash);
  });

  it('暂缓与失败属于不同处理状态', () => {
    const deferredHash = buildSummaryStateHash([], [], [], [], [], ['src/a.ts:10 — 本轮尚未执行']);
    const failedHash = buildSummaryStateHash([], ['src/a.ts:10 — 修复失败'], [], [], []);

    expect(deferredHash).not.toBe(failedHash);
  });
});

describe('refreshDiscussionProcessedHeadSha', () => {
  it('使用自动推送后的最新 HEAD 更新 discussion 水位', async () => {
    const provider = mockOf<GitLabProvider>({
      getMRShaInfo: vi.fn().mockResolvedValue({ baseSha: 'base', headSha: 'new-head' }),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      maintainerThreadState: {
        'discussion-1': {
          decisions: {},
          lastReviewerNoteAt: 0,
          lastProcessedHeadSha: 'old-head',
        },
      },
    });

    const headSha = await refreshDiscussionProcessedHeadSha(provider, 7, 'discussion-1', state);

    expect(headSha).toBe('new-head');
    expect(state.maintainerThreadState?.['discussion-1'].lastProcessedHeadSha).toBe('new-head');
  });
});

const mockFinding: ReviewFinding = {
  severity: 'MEDIUM',
  file: 'src/index.ts',
  line: 2,
  message: '变量未使用',
  suggestion: '删除',
  autoFixable: true,
};

describe('MaintainerRunner', () => {
  it('代码型 CI 修复未成功时仍阻断本轮普通 discussion', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const provider = mockOf<GitLabProvider>({
      getCIStatus: vi.fn().mockResolvedValue('failed'),
      getCiFailureReport: vi.fn().mockResolvedValue({
        status: 'failed',
        pipelineId: 42,
        failedJobs: [
          {
            id: 7,
            name: 'typecheck',
            stage: 'build',
            failureReason: 'script_failure',
            traceTail: 'src/module.ts(12,15): error TS2305: Module has no exported member.',
          },
        ],
      }),
      createDiscussion: vi.fn().mockResolvedValue('ci-discussion'),
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
    });
    const actor = mockOf<MaintainerActor>({
      executeCiFix: vi.fn().mockResolvedValue({
        codeApplied: false,
        reason: '本轮未能消除类型错误',
        appliedFiles: [],
      }),
    });
    const lifecycle = createLifecycleState(mockMR);
    const config: MaintainerConfig = {
      role: 'maintainer',
      enabled: true,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
      maintainerName: 'Maintainer',
      autoFixEnabled: true,
      resolveOthersDiscussions: true,
    };
    const ciRunner = runner as unknown as {
      handleCiStatus(
        provider: GitLabProvider,
        actor: MaintainerActor,
        mr: MergeRequest,
        lifecycle: MrLifecycleState,
        config: MaintainerConfig,
        maintainerName: string,
        currentHeadSha?: string
      ): Promise<CiHandlingResult>;
    };

    const result = await ciRunner.handleCiStatus(
      provider,
      actor,
      mockMR,
      lifecycle,
      config,
      'Maintainer',
      'head-1'
    );

    expect(actor.executeCiFix).toHaveBeenCalledOnce();
    expect(result).toEqual({
      fixAttempted: true,
      fixPushed: false,
      deferDiscussionProcessing: true,
    });
    expect(lifecycle.ci?.fixAttempts).toBe(1);
  });

  it('合并路径别名后复用成功终态，不再重复处理同一 finding', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const canonicalFile = 'modules/example-a/src/tracker.test.ts';
    const absoluteFile = `/ci/builds/group/sample-repo/${canonicalFile}`;
    const discussion: Discussion = {
      id: 'd-path-alias',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 10,
          author: 'reviewer-bot',
          body: [
            '## CI Review · Round 1',
            '### AI 分析',
            '#### 🟢 低风险',
            `- ${absoluteFile}:20 | 测试说明需要确认 | 保持现有实现`,
          ].join('\n'),
          createdAt: '2026-07-20T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: canonicalFile,
          additions: 1,
          deletions: 0,
          oldPath: canonicalFile,
          newPath: canonicalFile,
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });
    const brain = mockOf<MaintainerBrain>({
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn(),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            [`${absoluteFile}:20`]: {
              action: 'fix',
              reason: '旧路径修复失败',
              failedAttempts: 1,
              decidedAt: 2,
            },
            [`${canonicalFile}:20`]: {
              action: 'fix',
              reason: '已经修复',
              failedAttempts: 0,
              fixSucceeded: true,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: Date.parse('2026-07-20T00:00:00Z'),
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/virtual/workspace/sample-repo'
    );

    const threadState = state.maintainerThreadState?.[discussion.id];
    expect(threadState?.activeFindingKeys).toEqual([`${canonicalFile}:20`]);
    expect(threadState?.decisions).not.toHaveProperty(`${absoluteFile}:20`);
    expect(threadState?.decisions[`${canonicalFile}:20`].fixSucceeded).toBe(true);
    expect(brain.decide).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
  });

  it('调用 brain.decide 时传入 mrContext 与 relatedFindings', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/index.ts',
          additions: 1,
          deletions: 0,
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([mockFinding]),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([mockFinding]),
      decide: vi.fn().mockResolvedValue({
        action: 'fix',
        reason: '可以删除',
        fixDescription: '删除未使用变量',
        analysis: '未使用',
        consideredOptions: ['删除'],
        reasoning: '删除更干净',
        confidence: 'high',
        scope: 'local',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue(undefined),
    });

    const worktreeManager = mockOf<WorktreeManager>({
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      prepareEnvironment: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue('src/index.ts'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'const a = 1;\nconst b = 2;',
        snippetStartLine: 1,
        snippetEndLine: 2,
        totalLines: 2,
        truncated: false,
        targetLine: 2,
      }),
      readFile: vi.fn().mockReturnValue('const a = 1;\nconst b = 2;\n'),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      mockDiscussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        mrContext: expect.objectContaining({ iid: mockMR.iid }),
        relatedFindings: [],
      })
    );
    expect(provider.getMRDiff).toHaveBeenCalledWith(mockMR.iid);
  });

  it('单条 finding 首次修复失败时保留自动重试而不立即提问', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const finding: ReviewFinding = {
      severity: 'MEDIUM',
      file: 'src/a.ts',
      line: 8,
      message: '需要调整边界条件',
      suggestion: '修正判断逻辑',
    };
    const discussion: Discussion = {
      id: 'd-single-retry',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer-bot',
          body: 'src/a.ts:8 | 需要调整边界条件',
          createdAt: '2026-08-04T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([finding]),
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn().mockResolvedValue({
        action: 'fix',
        reason: '需要修复',
        fixDescription: '修正判断逻辑',
        scope: 'local',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue({
        codeApplied: false,
        replyPosted: false,
        resolved: false,
        awaitingReply: false,
        pending: false,
        error: '本地验证暂未通过',
      }),
      postSummary: vi.fn().mockResolvedValue({
        replyPosted: true,
        resolved: false,
        pending: false,
      }),
    });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue(finding.file),
      getWorktreePath: vi.fn().mockReturnValue('/virtual-worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'export const value = true;',
        snippetStartLine: 1,
        snippetEndLine: 12,
        totalLines: 12,
        truncated: false,
        targetLine: finding.line,
      }),
    });
    const state = mockOf<MrAgentState>({ interactiveThreads: {}, processedDiscussions: {} });

    await runner.processDiscussion(
      mockMR,
      discussion,
      mockOf<GitLabProvider>({
        getMRDiff: vi.fn().mockResolvedValue([
          {
            filePath: finding.file,
            additions: 1,
            deletions: 0,
            oldPath: finding.file,
            newPath: finding.file,
            newFile: false,
            deletedFile: false,
            diff: '',
          },
        ]),
      }),
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/virtual-project'
    );

    expect(actor.applyDecision).toHaveBeenCalledWith(
      mockMR,
      discussion,
      finding,
      expect.objectContaining({ action: 'fix' }),
      state,
      { askOnFixFailure: false }
    );
    expect(actor.postSummary).toHaveBeenCalledWith(
      mockMR,
      discussion,
      [],
      ['src/a.ts:8 — 本地验证暂未通过'],
      [],
      [],
      [],
      state
    );
    expect(state.maintainerThreadState?.[discussion.id]?.decisions['src/a.ts:8']).toMatchObject({
      action: 'fix',
      failedAttempts: 1,
      fixSucceeded: false,
    });
    expect(state.interactiveThreads[discussion.id]).toBeUndefined();
  });

  it('无法解析 finding 时由 LLM 决策 record，只录入记忆不回复', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const statsDiscussion: Discussion = {
      id: 'd-stats',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'project_123_bot',
          body: [
            'Metric    Previous    Current    Delta',
            'Error    0    0    +0',
            'Warning    2724    2723    -1',
          ].join('\n'),
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const recordProjectKnowledge = vi.fn().mockResolvedValue(undefined);
    const memoryClient = mockOf<MemoryClient>({ recordProjectKnowledge });

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'record',
        reason: '纯统计报告',
        memoryCategory: 'risk',
        memoryContent: 'ESLint delta: Warning -1',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn(),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      statsDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project',
      memoryClient
    );

    expect(brain.decideNonFindingComment).toHaveBeenCalled();
    expect(recordProjectKnowledge).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'risk',
          content: expect.stringContaining('ESLint delta'),
        }),
      ])
    );
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(actor.postSummary).not.toHaveBeenCalled();
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-stats']).toBeDefined();
  });

  it('无法解析 finding 时 LLM 决策 ask 会发布澄清问题', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const vagueDiscussion: Discussion = {
      id: 'd-vague',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer',
          body: '这里好像有点问题，改一下',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ask',
        reason: '缺少文件路径',
        question: '请补充具体文件和行号',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      vagueDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.decideNonFindingComment).toHaveBeenCalled();
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      'd-vague',
      expect.stringContaining('请补充具体文件和行号')
    );
    expect(state.processedDiscussions?.['d-vague']).toBeDefined();
  });

  it('无法解析 finding 时 LLM 决策 ignore 并带轻松回复时会发布回复', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const praiseDiscussion: Discussion = {
      id: 'd-praise',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer',
          body: '🟢 低风险\n\n优点：命名更准确，测试意图更清晰，可接受',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ignore',
        reason: 'Reviewer 已确认可接受',
        replyBody: '👍 感谢 Reviewer 的确认，这些点我已核对，无需额外修改。',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      praiseDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.decideNonFindingComment).toHaveBeenCalled();
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      'd-praise',
      expect.stringContaining('感谢 Reviewer')
    );
    expect(state.processedDiscussions?.['d-praise']).toBeDefined();
  });

  it('来自 Agent 的非 finding 汇总/赞扬评论不发布轻松回复', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const agentSummaryDiscussion: Discussion = {
      id: 'd-agent-summary',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: '🟡 中风险\n\n优点：命名更准确，测试意图更清晰，可接受\n\n---\n*生成于 2026/07/17 · CodeKeeper Advance MR 评审 Agent · bot*',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ignore',
        reason: '汇总评论',
        replyBody: '👍 感谢 Reviewer 的确认，这些点我已核对，无需额外修改。',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      agentSummaryDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.decideNonFindingComment).toHaveBeenCalled();
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-agent-summary']).toBeDefined();
  });

  it('来自 Agent 的非 finding 评论即使 LLM 决策 ask 也不发问', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const agentVagueDiscussion: Discussion = {
      id: 'd-agent-vague',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: 'AI 分析 ✅ 建议合入\n\n---\n*生成于 2026/07/17 · CodeKeeper Advance MR 评审 Agent · bot*',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ask',
        reason: '缺少文件路径',
        question: '请补充具体文件和行号',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      agentVagueDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.decideNonFindingComment).toHaveBeenCalled();
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-agent-vague']).toBeDefined();
  });

  it('单条 finding 已标记为已修复且无新回复时不再重复处理', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/index.ts',
          additions: 1,
          deletions: 0,
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([mockFinding]),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([mockFinding]),
      decide: vi.fn(),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const worktreeManager = mockOf<WorktreeManager>({
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      prepareEnvironment: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue('src/index.ts'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'const a = 1;\nconst b = 2;',
        snippetStartLine: 1,
        snippetEndLine: 2,
        totalLines: 2,
        truncated: false,
        targetLine: 2,
      }),
      readFile: vi.fn().mockReturnValue('const a = 1;\nconst b = 2;\n'),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/index.ts:2': {
              action: 'ignore',
              alreadyFixed: true,
              reason: '已修复',
              failedAttempts: 0,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: new Date('2026-07-08T00:00:00Z').getTime(),
          // 该 discussion 唯一 note 是这条无 Agent 署名的评论（视为人工），
          // lastHumanNoteAt 与其持平表示没有人工新回复，应直接复用历史决策
          lastHumanNoteAt: new Date('2026-07-08T00:00:00Z').getTime(),
        },
      },
    });

    const repliedDiscussion: Discussion = {
      ...mockDiscussion,
      notes: [
        ...mockDiscussion.notes,
        {
          id: 2,
          author: 'maintainer-bot',
          body: '✅ 已修复：当前代码已满足要求\n\n---\n*生成于 2026/07/08 · CodeKeeper Advance MR 维护 Agent · Maintainer*',
          createdAt: '2026-07-08T01:00:00Z',
          resolved: false,
        },
      ],
    };

    await runner.processDiscussion(
      mockMR,
      repliedDiscussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.decide).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-1']).toBeDefined();
  });

  it('已有已修复结论时，Reviewer bot 自动重扫的新 note 不触发重跑也不重复回复', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/index.ts',
          additions: 1,
          deletions: 0,
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([mockFinding]),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([mockFinding]),
      decide: vi.fn(),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const worktreeManager = mockOf<WorktreeManager>({
      resolveFilePath: vi.fn().mockResolvedValue('src/index.ts'),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'const a = 1;\nconst b = 2;',
        snippetStartLine: 1,
        snippetEndLine: 2,
        totalLines: 2,
        truncated: false,
        targetLine: 2,
      }),
      readFile: vi.fn().mockReturnValue('const a = 1;\nconst b = 2;\n'),
    });

    // discussion 里两条 note 都是 Agent 所发（含 CodeKeeper Advance 署名），
    // 模拟 Reviewer bot 重扫补发；没有任何人工 note
    const botDiscussion: Discussion = {
      id: 'd-1',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer-bot',
          body: 'src/index.ts:2 变量未使用\n\n---\n*生成于 2026/07/08 · CodeKeeper Advance MR 评审 Agent · 小评*',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
        {
          id: 2,
          author: 'reviewer-bot',
          body: '重扫后仍认为有问题\n\n---\n*生成于 2026/07/09 · CodeKeeper Advance MR 评审 Agent · 小评*',
          createdAt: '2026-07-09T00:00:00Z',
          resolved: false,
        },
        {
          id: 3,
          author: 'maintainer-bot',
          body: '✅ 已修复：当前代码已满足要求\n\n---\n*生成于 2026/07/09 · CodeKeeper Advance MR 维护 Agent · Maintainer*',
          createdAt: '2026-07-09T01:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/index.ts:2': {
              action: 'ignore',
              alreadyFixed: true,
              reason: '已修复',
              failedAttempts: 0,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      botDiscussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // bot 重扫不带新信息：不重跑 LLM、不重复回复
    expect(brain.decide).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-1']).toBeDefined();
  });

  it('人工追问后结论未变时，重新评估但不重复回复', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/index.ts',
          additions: 1,
          deletions: 0,
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    // 人工追问后，LLM 仍判定为已修复（与历史结论一致）
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([mockFinding]),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([mockFinding]),
      decide: vi.fn().mockResolvedValue({
        action: 'ignore',
        alreadyFixed: true,
        reason: '已修复',
        replyBody: '第 2 行已删除该变量',
        analysis: '已修复',
        consideredOptions: ['忽略'],
        reasoning: '问题已不存在',
        confidence: 'high',
        scope: 'local',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      prepareEnvironment: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue('src/index.ts'),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'const a = 1;\nconst b = 2;',
        snippetStartLine: 1,
        snippetEndLine: 2,
        totalLines: 2,
        truncated: false,
        targetLine: 2,
      }),
      readFile: vi.fn().mockReturnValue('const a = 1;\nconst b = 2;\n'),
    });

    // 一条 Agent finding + 一条人工追问（无署名）
    const humanDiscussion: Discussion = {
      id: 'd-1',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer-bot',
          body: 'src/index.ts:2 变量未使用\n\n---\n*生成于 2026/07/08 · CodeKeeper Advance MR 评审 Agent · 小评*',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
        {
          id: 2,
          author: 'human-dev',
          body: '这个确定已经改了吗？',
          createdAt: '2026-07-09T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        'd-1': {
          decisions: {
            'src/index.ts:2': {
              action: 'ignore',
              alreadyFixed: true,
              reason: '已修复',
              failedAttempts: 0,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      humanDiscussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // 人工追问会触发重评估，但结论未变则不重复回复
    expect(brain.decide).toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-1']).toBeDefined();
  });

  it('明确的 ESLint 统计报告在 finding 解析前确定性跳过', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/index.ts',
          additions: 1,
          deletions: 0,
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    // parseFindings 把 Top files 表格误解析成多条 line:1 的文件级 finding
    const aggregateFindings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/app/core.ts',
        line: 1,
        message: '0 | 203',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/gateway.ts',
        line: 1,
        message: '0 | 188',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/auth.ts',
        line: 1,
        message: '0 | 123',
        suggestion: '',
        autoFixable: false,
      },
    ];

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(aggregateFindings),
      enrichFindingsWithCases: vi.fn(),
      isStatisticalReport: vi.fn().mockResolvedValue(true),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const reportDiscussion: Discussion = {
      id: 'd-report',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: 'ESLint Report\nSeverity    Count\nError    0\nWarning    2724\n\nTop rules\nRule    Count\nno-console    1251\n\nTop files\nFile    Errors    Warnings\nsrc/app/core.ts    0    203\nsrc/app/gateway.ts    0    188\nsrc/app/auth.ts    0    123',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {},
    });

    await runner.processDiscussion(
      mockMR,
      reportDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.parseFindings).not.toHaveBeenCalled();
    expect(brain.isStatisticalReport).not.toHaveBeenCalled();
    expect(provider.getMRDiff).not.toHaveBeenCalled();
    expect(brain.enrichFindingsWithCases).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-report']).toBeDefined();
    expect(state.maintainerThreadState?.['d-report']?.statisticalReport).toBe(true);
  });

  it('格式不完整的聚合报告仍通过 LLM 语义判定后跳过', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/index.ts',
          additions: 1,
          deletions: 0,
          oldPath: 'src/index.ts',
          newPath: 'src/index.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    // parseFindings 把 Top files 表格误解析成多条 line:1 的文件级 finding
    const aggregateFindings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/app/core.ts',
        line: 1,
        message: '0 | 203',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/gateway.ts',
        line: 1,
        message: '0 | 188',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/auth.ts',
        line: 1,
        message: '0 | 123',
        suggestion: '',
        autoFixable: false,
      },
    ];

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(aggregateFindings),
      enrichFindingsWithCases: vi.fn(),
      isStatisticalReport: vi.fn().mockResolvedValue(true),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const reportDiscussion: Discussion = {
      id: 'd-report',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: 'Lint 统计\n\nTop files\nFile    Errors    Warnings\nsrc/app/core.ts    0    203\nsrc/app/gateway.ts    0    188\nsrc/app/auth.ts    0    123',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {},
    });

    await runner.processDiscussion(
      mockMR,
      reportDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.isStatisticalReport).toHaveBeenCalled();
    expect(brain.enrichFindingsWithCases).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-report']).toBeDefined();
    expect(state.maintainerThreadState?.['d-report']?.statisticalReport).toBe(true);
  });

  it('空格分隔的 ESLint 全局报告在解析前确定性跳过', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    // 解析为聚合条目后命中纯统计报告闸，不再拉取 MR diff
    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const aggregateFindings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/app/core.ts',
        line: 1,
        message: '0    203',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/gateway.ts',
        line: 1,
        message: '0    188',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/auth.ts',
        line: 1,
        message: '0    123',
        suggestion: '',
        autoFixable: false,
      },
    ];

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(aggregateFindings),
      isStatisticalReport: vi.fn().mockResolvedValue(true),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const reportDiscussion: Discussion = {
      id: 'd-report-pre',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: [
            'ESLint Report',
            'Severity    Count',
            'Error    0',
            'Warning    2724',
            '',
            'Top files',
            'File    Errors    Warnings',
            'src/app/core.ts    0    203',
            'src/app/gateway.ts    0    188',
            'src/app/auth.ts    0    123',
          ].join('\n'),
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {},
    });

    await runner.processDiscussion(
      mockMR,
      reportDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.parseFindings).not.toHaveBeenCalled();
    expect(brain.isStatisticalReport).not.toHaveBeenCalled();
    expect(provider.getMRDiff).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.['d-report-pre']?.statisticalReport).toBe(true);
    expect(state.processedDiscussions?.['d-report-pre']).toBeDefined();
  });

  it('统计+分析混合报告剥离聚合条目后正常处理可操作 finding', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/app/tracker.ts',
          additions: 5,
          deletions: 0,
          oldPath: 'src/app/tracker.ts',
          newPath: 'src/app/tracker.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    // 混合报告：前两条是 Top files 统计行，最后一条是 reviewer 的具体分析
    const mixedFindings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/app/core.ts',
        line: 1,
        message: '0    203',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/gateway.ts',
        line: 1,
        message: '0    188',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'MEDIUM',
        file: 'src/app/tracker.ts',
        line: 35,
        message: 'no-op 测试未验证真正的 noop 状态',
        suggestion: '在 beforeEach 中重置',
        autoFixable: true,
      },
    ];

    const realFinding = mixedFindings[2];
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(mixedFindings),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([realFinding]),
      isStatisticalReport: vi.fn(),
      decide: vi.fn().mockResolvedValue({
        action: 'ignore',
        alreadyFixed: true,
        reason: '已修复',
        replyBody: '当前测试已重置 noop 状态',
        analysis: '已修复',
        consideredOptions: [],
        reasoning: '问题已不存在',
        confidence: 'high',
        scope: 'local',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue(true),
    });

    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      prepareEnvironment: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue('src/app/tracker.ts'),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'describe("noop", () => {});',
        snippetStartLine: 30,
        snippetEndLine: 40,
        totalLines: 100,
        truncated: false,
        targetLine: 35,
      }),
      readFile: vi.fn().mockReturnValue('describe("noop", () => {});\n'),
    });

    const mixedDiscussion: Discussion = {
      id: 'd-mixed',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: [
            'ESLint Report',
            'Severity    Count',
            'Error    0',
            'Warning    20',
            '',
            'Top rules',
            'Rule    Count',
            'no-console    12',
            '',
            'Top files',
            'File    Errors    Warnings',
            'src/app/core.ts    0    8',
            'src/app/gateway.ts    0    7',
            '',
            '⚠️ 发现项',
            '',
            '🔴 **高** (1)',
            '',
            'src/app/tracker.ts:35 · 规则 TEST-COVERAGE no-op 测试未验证真正的 noop 状态。**建议**：在测试准备阶段显式重置 tracker。',
          ].join('\n'),
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {},
    });

    await runner.processDiscussion(
      mockMR,
      mixedDiscussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // 不走统计报告判定，聚合条目被剥离，可操作 finding 正常决策
    expect(brain.isStatisticalReport).not.toHaveBeenCalled();
    expect(brain.enrichFindingsWithCases).toHaveBeenCalledWith([realFinding], mockMR.iid);
    expect(brain.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        finding: expect.objectContaining({ file: 'src/app/tracker.ts', line: 35 }),
      })
    );
    expect(state.maintainerThreadState?.['d-mixed']?.statisticalReport).toBeFalsy();
  });

  it('已缓存统计报告标记的讨论解析出可操作 finding 时清除标记并处理', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([
        {
          filePath: 'src/app/tracker.ts',
          additions: 5,
          deletions: 0,
          oldPath: 'src/app/tracker.ts',
          newPath: 'src/app/tracker.ts',
          newFile: false,
          deletedFile: false,
          diff: '',
        },
      ]),
    });

    const realFinding: ReviewFinding = {
      severity: 'MEDIUM',
      file: 'src/app/tracker.ts',
      line: 35,
      message: 'no-op 测试未验证 noop 状态',
      suggestion: '重置 tracker',
      autoFixable: true,
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([realFinding]),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([realFinding]),
      isStatisticalReport: vi.fn(),
      decide: vi.fn().mockResolvedValue({
        action: 'ignore',
        alreadyFixed: true,
        reason: '已修复',
        replyBody: '已重置',
        analysis: '已修复',
        consideredOptions: [],
        reasoning: '问题已不存在',
        confidence: 'high',
        scope: 'local',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue(true),
    });

    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      prepareEnvironment: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue('src/app/tracker.ts'),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'code',
        snippetStartLine: 30,
        snippetEndLine: 40,
        totalLines: 100,
        truncated: false,
        targetLine: 35,
      }),
      readFile: vi.fn().mockReturnValue('code\n'),
    });

    const cachedDiscussion: Discussion = {
      id: 'd-cached-mixed',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: 'CI Review 报告（之前被误判为统计报告）',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        'd-cached-mixed': {
          decisions: {},
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
          statisticalReport: true,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      cachedDiscussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // 标记被清除，finding 正常处理
    expect(state.maintainerThreadState?.['d-cached-mixed']?.statisticalReport).toBe(false);
    expect(brain.decide).toHaveBeenCalled();
    expect(brain.isStatisticalReport).not.toHaveBeenCalled();
  });

  it('交互式提问超时未回复时清理等待状态并发布收尾说明', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const interactiveDiscussion: Discussion = {
      id: 'd-interactive',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'human-dev',
          body: '这个文件为什么这样改？',
          createdAt: '2026-07-01T00:00:00Z',
          resolved: false,
        },
        {
          id: 2,
          author: 'maintainer',
          body: '能否补充一下期望的修改方式？\n\n---\n*生成于 2026/07/01 01:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-07-01T01:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn(),
      decide: vi.fn(),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {
        // askedAt 与提问 note 时间一致（2026-07-01），距测试运行日已超过 3 天超时
        'd-interactive': {
          status: 'awaiting-reply',
          askedAt: new Date('2026-07-01T01:00:00Z').getTime(),
          question: '能否补充？',
          filePath: 'src/a.ts',
        },
      },
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      interactiveDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // 超时后：发布收尾说明、清理交互状态、不再调用 LLM
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      'd-interactive',
      expect.stringContaining('暂时搁置')
    );
    expect(state.interactiveThreads['d-interactive']).toBeUndefined();
    expect(brain.decide).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-interactive']).toBeDefined();
  });

  it('交互式提问超时且讨论无人工参与者时静默清理，不发收尾说明', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const agentOnlyDiscussion: Discussion = {
      id: 'd-agent-interactive',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer-bot',
          body: 'src/a.ts:1 变量未使用\n\n---\n*生成于 2026/07/01 · CodeKeeper Advance MR 评审 Agent · bot*',
          createdAt: '2026-07-01T00:00:00Z',
          resolved: false,
        },
        {
          id: 2,
          author: 'maintainer',
          body: '能否补充一下期望？\n\n---\n*生成于 2026/07/01 01:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-07-01T01:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn(),
      decide: vi.fn(),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {
        // askedAt 与提问 note 时间一致（2026-07-01），距测试运行日已超过 3 天超时
        'd-agent-interactive': {
          status: 'awaiting-reply',
          askedAt: new Date('2026-07-01T01:00:00Z').getTime(),
          question: '能否补充？',
          filePath: 'src/a.ts',
        },
      },
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      agentOnlyDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.interactiveThreads['d-agent-interactive']).toBeUndefined();
    expect(brain.decide).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-agent-interactive']).toBeDefined();
  });

  it('等待 Reviewer 回复时继续处理同 discussion 的可重试 finding', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const askedAt = Date.now() - 60_000;
    const findings: ReviewFinding[] = [
      {
        severity: 'MEDIUM',
        file: 'src/a.ts',
        line: 10,
        message: '需要确认业务意图',
        suggestion: '请确认预期行为',
      },
      {
        severity: 'MEDIUM',
        file: 'src/b.ts',
        line: 20,
        message: '缺少边界保护',
        suggestion: '补充边界判断',
      },
    ];
    const discussion: Discussion = {
      id: 'd-awaiting-with-retry',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer-agent',
          body: '包含两个待处理 finding',
          createdAt: new Date(askedAt - 60_000).toISOString(),
          resolved: false,
        },
        {
          id: 2,
          author: 'maintainer',
          body: '请确认业务意图\n\n---\n*生成于 2026/08/03 10:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: new Date(askedAt).toISOString(),
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(findings),
      enrichFindingsWithCases: vi.fn().mockImplementation(async items => items),
      decide: vi.fn().mockResolvedValue({
        action: 'fix',
        reason: '可以自动补充保护',
        fixDescription: '补充边界判断',
        scope: 'local',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      executeBatchFix: vi.fn().mockResolvedValue({
        success: true,
        reason: '已推送',
        appliedFiles: ['src/b.ts'],
        deletedFiles: [],
        alreadyFixedItems: [],
        itemResults: [{ file: 'src/b.ts', line: 20, status: 'fixed' }],
      }),
      postSummary: vi.fn().mockResolvedValue({
        replyPosted: true,
        resolved: false,
        pending: false,
      }),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockImplementation(async (path: string) => path),
      readFileWindow: vi.fn().mockImplementation(async (_path: string, finding: ReviewFinding) => ({
        imports: '',
        snippet: `line ${finding.line}`,
        snippetStartLine: finding.line,
        snippetEndLine: finding.line,
        totalLines: 30,
        truncated: false,
        targetLine: finding.line,
      })),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {
        [discussion.id]: {
          status: 'awaiting-reply',
          askedAt,
          question: '请确认业务意图',
          filePath: 'src/a.ts',
        },
      },
      processedDiscussions: {},
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            'src/a.ts:10': {
              action: 'ask',
              reason: '需要人工确认',
              question: '请确认业务意图',
              failedAttempts: 0,
              decidedAt: askedAt,
            },
            'src/b.ts:20': {
              action: 'fix',
              reason: '需要补充保护',
              failedAttempts: 1,
              fixSucceeded: false,
              decidedAt: askedAt,
            },
          },
          activeFindingKeys: ['src/a.ts:10', 'src/b.ts:20'],
          lastReviewerNoteAt: askedAt - 60_000,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(actor.executeBatchFix).toHaveBeenCalledOnce();
    expect(actor.postSummary).toHaveBeenCalledOnce();
    expect(vi.mocked(actor.postSummary).mock.calls[0][2]).toEqual(['src/b.ts:20']);
    expect(vi.mocked(actor.postSummary).mock.calls[0][4]).toEqual([]);
    expect(state.interactiveThreads[discussion.id]).toMatchObject({
      status: 'awaiting-reply',
      question: '请确认业务意图',
    });
  });

  it('按逐 finding 批量结果更新状态，暂缓项不累计失败次数', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const findings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/a.ts',
        line: 10,
        message: '检查已存在的保护',
        suggestion: '确认当前实现',
      },
      {
        severity: 'MEDIUM',
        file: 'src/b.ts',
        line: 20,
        message: '补充边界判断',
        suggestion: '修正函数逻辑',
      },
      {
        severity: 'LOW',
        file: 'src/c.ts',
        line: 30,
        message: '清理多余分支',
        suggestion: '删除冗余代码',
      },
    ];
    const discussion: Discussion = {
      id: 'd-item-results',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'reviewer-agent',
          body: '三个独立的检查项',
          createdAt: '2026-08-03T00:00:00.000Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(findings),
      enrichFindingsWithCases: vi.fn().mockImplementation(async items => items),
      decide: vi.fn().mockResolvedValue({
        action: 'fix',
        reason: '可以自动处理',
        fixDescription: '按 finding 修改目标文件',
        scope: 'local',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      executeBatchFix: vi.fn().mockResolvedValue({
        success: false,
        reason: '第二项修复失败',
        appliedFiles: [],
        deletedFiles: [],
        alreadyFixedItems: [{ file: 'src/a.ts', line: 10, reason: '当前代码已有所需保护' }],
        itemResults: [
          {
            file: 'src/a.ts',
            line: 10,
            status: 'already-fixed',
            reason: '当前代码已有所需保护',
          },
          { file: 'src/b.ts', line: 20, status: 'failed', reason: '目标函数仍缺少保护' },
          { file: 'src/c.ts', line: 30, status: 'deferred', reason: '本轮尚未执行' },
        ],
      }),
      postSummary: vi.fn().mockResolvedValue({
        replyPosted: true,
        resolved: false,
        pending: false,
      }),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockImplementation(async (path: string) => path),
      readFileWindow: vi.fn().mockImplementation(async (_path: string, finding: ReviewFinding) => ({
        imports: '',
        snippet: `line ${finding.line}`,
        snippetStartLine: finding.line,
        snippetEndLine: finding.line,
        totalLines: 40,
        truncated: false,
        targetLine: finding.line,
      })),
    });
    const state = mockOf<MrAgentState>({ interactiveThreads: {}, processedDiscussions: {} });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    const decisions = state.maintainerThreadState?.[discussion.id]?.decisions;
    expect(decisions?.['src/a.ts:10']).toMatchObject({
      action: 'ignore',
      alreadyFixed: true,
      failedAttempts: 0,
    });
    expect(decisions?.['src/b.ts:20']).toMatchObject({
      action: 'fix',
      failedAttempts: 1,
      lastFailureReason: '目标函数仍缺少保护',
    });
    expect(decisions?.['src/c.ts:30']).toMatchObject({
      action: 'fix',
      failedAttempts: 0,
    });
    expect(vi.mocked(actor.postSummary).mock.calls[0][3]).toEqual([
      'src/b.ts:20 — 目标函数仍缺少保护',
    ]);
    expect(vi.mocked(actor.postSummary).mock.calls[0][8]).toEqual(['src/c.ts:30 — 本轮尚未执行']);
  });

  it('非 finding 讨论已有 Maintainer 回复但无处理记录时静默补记跳过', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    // 旧版本对无法解析的评论发过轻松回复，但没留下任何处理记录
    const strayReplyDiscussion: Discussion = {
      id: 'd-stray',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: '一段无法解析出 finding 的评论内容',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
        {
          id: 2,
          author: 'maintainer',
          body: '感谢分享\n\n---\n*生成于 2026/07/08 01:00:00 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-07-08T01:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      decideNonFindingComment: vi.fn(),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {},
    });

    await runner.processDiscussion(
      mockMR,
      strayReplyDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // 不再调 LLM、不再发回复，只静默补记处理证据
    expect(brain.decideNonFindingComment).not.toHaveBeenCalled();
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.['d-stray']?.nonFindingAction).toBe('ignore');
    expect(state.processedDiscussions?.['d-stray']).toBeDefined();
  });

  it('首条 Reviewer note 仅编辑时间变化时重新评估历史 finding 决策', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const previousActivityAt = Date.parse('2026-07-20T00:00:00.000Z');
    const updatedActivityAt = Date.parse('2026-07-21T00:00:00.000Z');
    const finding: ReviewFinding = {
      severity: 'LOW',
      file: 'virtual/module-a.ts',
      line: 18,
      message: '编辑后的问题描述',
      suggestion: '根据当前实现重新判断',
    };
    const discussion: Discussion = {
      id: 'd-edited-finding',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 11,
          author: 'reviewer-bot',
          body: `${finding.file}:${finding.line} | ${finding.message} | ${finding.suggestion}`,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          resolved: false,
        },
        {
          id: 12,
          author: 'maintainer-bot',
          body: `✅ 已修复（无需重复修改）：\n\n${finding.file}:${finding.line}: 旧结论\n\n---\n*生成于 2026/07/20 · CodeKeeper Advance MR 维护 Agent · bot*`,
          createdAt: '2026-07-20T01:00:00.000Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([finding]),
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn().mockResolvedValue({
        action: 'ignore',
        alreadyFixed: true,
        reason: '重新检查后仍无需修改',
        replyBody: '当前实现仍满足要求',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });
    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([]),
    });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue(finding.file),
      getWorktreePath: vi.fn().mockReturnValue('/virtual-worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'export const currentValue = true;',
        snippetStartLine: 1,
        snippetEndLine: 24,
        totalLines: 24,
        truncated: false,
        targetLine: finding.line,
      }),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {
        [discussion.id]: { noteCount: 2, processedAt: previousActivityAt },
      },
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            [`${finding.file}:${finding.line}`]: {
              action: 'ignore',
              alreadyFixed: true,
              reason: '旧结论',
              replyBody: '旧说明',
              failedAttempts: 0,
              decidedAt: previousActivityAt,
            },
          },
          lastReviewerNoteAt: previousActivityAt,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/virtual-project'
    );

    expect(brain.decide).toHaveBeenCalledOnce();
    expect(brain.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        finding,
        originalComment: discussion.notes[0].body,
        staleFinding: false,
      })
    );
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.[discussion.id]?.lastReviewerNoteAt).toBe(
      updatedActivityAt
    );
  });

  it('首条 Reviewer note 编辑后即使仍为 fix 也会重新执行修复', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const previousActivityAt = Date.parse('2026-07-20T00:00:00.000Z');
    const finding: ReviewFinding = {
      severity: 'MEDIUM',
      file: 'virtual/module-b.ts',
      line: 24,
      message: '编辑后的修复要求',
      suggestion: '按新要求调整实现',
    };
    const discussion: Discussion = {
      id: 'd-edited-fix',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 31,
          author: 'reviewer-bot',
          body: `${finding.file}:${finding.line} | ${finding.message}`,
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([finding]),
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn().mockResolvedValue({
        action: 'fix',
        reason: '需要按编辑后的要求继续修改',
        fixDescription: '调整当前实现',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue({
        codeApplied: true,
        replyPosted: true,
        resolved: true,
        awaitingReply: false,
        pending: false,
      }),
    });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue(finding.file),
      getWorktreePath: vi.fn().mockReturnValue('/virtual-worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'export const currentValue = true;',
        snippetStartLine: 1,
        snippetEndLine: 30,
        totalLines: 30,
        truncated: false,
        targetLine: finding.line,
      }),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {
        [discussion.id]: { noteCount: 1, processedAt: previousActivityAt },
      },
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            [`${finding.file}:${finding.line}`]: {
              action: 'fix',
              reason: '旧修复要求',
              failedAttempts: 0,
              fixSucceeded: true,
              decidedAt: previousActivityAt,
            },
          },
          lastReviewerNoteAt: previousActivityAt,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) }),
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/virtual-project'
    );

    expect(actor.applyDecision).toHaveBeenCalledOnce();
  });

  it('非 finding 首条 note 被编辑后不被已有 Maintainer 回复静默吞掉', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const previousActivityAt = Date.parse('2026-07-20T00:00:00.000Z');
    const updatedActivityAt = Date.parse('2026-07-21T00:00:00.000Z');
    const discussion: Discussion = {
      id: 'd-edited-non-finding',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 21,
          author: 'reviewer-bot',
          body: '更新后的普通设计说明，需要重新判断是否记录。',
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          resolved: false,
        },
        {
          id: 22,
          author: 'maintainer-bot',
          body: '感谢分享\n\n---\n*生成于 2026/07/20 · CodeKeeper Advance MR 维护 Agent · bot*',
          createdAt: '2026-07-20T01:00:00.000Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ignore',
        reason: '更新后仍无需采取动作',
      }),
    });
    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([]),
      addDiscussionNote: vi.fn(),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {
        [discussion.id]: { noteCount: 2, processedAt: previousActivityAt },
      },
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {},
          lastReviewerNoteAt: previousActivityAt,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      mockOf<MaintainerActor>({ applyDecision: vi.fn() }),
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/virtual-project'
    );

    expect(brain.decideNonFindingComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: discussion.notes[0].body })
    );
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.[discussion.id]?.nonFindingAction).toBe('ignore');
    expect(state.maintainerThreadState?.[discussion.id]?.lastReviewerNoteAt).toBe(
      updatedActivityAt
    );
  });

  it('来自 bot 作者（无 Agent 署名）的非 finding 评论即使 LLM 决策 ask 也不发问', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const botDiscussion: Discussion = {
      id: 'd-bot-vague',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'project_193142_bot_63ebd35e8f3b9293ee769e43fa413e1e',
          // CI Review 报告：无 CodeKeeper 署名，但作者是 GitLab project bot
          body: '🤖 CI Review · Round 1\n结论：✅ 通过\nAI 分析：建议合入',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([]),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ask',
        reason: '需要确认核心文件变更必要性',
        question: '请确认 src/app/main.ts 的变更是否必要？',
      }),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });

    const provider = mockOf<GitLabProvider>({
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
    });

    await runner.processDiscussion(
      mockMR,
      botDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    // bot 作者的评论不应成为提问对象
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.['d-bot-vague']?.nonFindingAction).toBe('ask');
    expect(state.processedDiscussions?.['d-bot-vague']).toBeDefined();
  });

  it('CI Review 中确认型规则与 finding 并存时只处理可操作 finding', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const trackerPath =
      'packages/example-memory/src/core/foundation/telemetry/__tests__/tracker.test.ts';
    const discussion: Discussion = {
      id: 'd-ci-structured',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: `## 🤖 CI Review · Round 8 · commit a1b2c3d4
### 规则扫描
- **关键入口保护策略** src/app/main.ts:1 | 保护文件被修改，请确认必要性
### AI 分析
#### 🟢 低风险
- ${trackerPath}:36 | 默认 sink 路径的测试覆盖可能不足 | 补充未注入时不抛异常的用例
#### 优点
- src/clean.ts:1 | import 已同步清理`,
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const parseFindings = vi.fn();
    const decide = vi.fn().mockResolvedValue({
      action: 'ignore',
      reason: '当前实现无需修改',
      analysis: '已满足要求',
      consideredOptions: [],
      reasoning: '完整文件已覆盖默认路径',
      confidence: 'high',
    });
    const brain = mockOf<MaintainerBrain>({
      parseFindings,
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide,
    });
    const actor = mockOf<MaintainerActor>({ applyDecision: vi.fn().mockResolvedValue(true) });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      prepareEnvironment: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockImplementation(async file => file),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'default sink test',
        snippetStartLine: 30,
        snippetEndLine: 40,
        totalLines: 50,
        truncated: false,
        targetLine: 36,
      }),
    });
    const state = mockOf<MrAgentState>({ interactiveThreads: {}, processedDiscussions: {} });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project',
      undefined,
      'standard',
      'ffffffff'
    );

    expect(parseFindings).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        finding: expect.objectContaining({ file: trackerPath, line: 36 }),
        relatedFindings: [],
        staleFinding: true,
      })
    );
    expect(actor.applyDecision).toHaveBeenCalledTimes(1);
    expect(worktreeManager.resolveFilePath).not.toHaveBeenCalledWith('src/app/main.ts');
  });

  it('统计报告判定已缓存后不再重复调用 LLM，直接静默跳过', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = mockOf<GitLabProvider>({
      getMRDiff: vi.fn().mockResolvedValue([]),
    });

    // 缓存命中后仍会解析重验；解析结果仍为聚合条目 → 继续静默跳过，不再调 LLM 判定
    const aggregateFindings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/app/core.ts',
        line: 1,
        message: '0    203',
        suggestion: '',
        autoFixable: false,
      },
      {
        severity: 'LOW',
        file: 'src/app/gateway.ts',
        line: 1,
        message: '0    188',
        suggestion: '',
        autoFixable: false,
      },
    ];

    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue(aggregateFindings),
      isStatisticalReport: vi.fn(),
    });

    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
    });

    const cachedReportDiscussion: Discussion = {
      id: 'd-report',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: 'ESLint Report\nSeverity    Count\nError    0\nWarning    2724\n\nTop files\nFile    Errors    Warnings\nsrc/app/core.ts    0    203\nsrc/app/gateway.ts    0    188',
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };

    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        'd-report': {
          decisions: {},
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
          statisticalReport: true,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      cachedReportDiscussion,
      provider,
      brain,
      actor,
      mockOf<WorktreeManager>({}),
      'CodeKeeper Maintainer',
      state,
      '/project'
    );

    expect(brain.isStatisticalReport).not.toHaveBeenCalled();
    expect(provider.getMRDiff).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.['d-report']?.statisticalReport).toBe(true);
    expect(state.processedDiscussions?.['d-report']).toBeDefined();
  });

  it('stale CI Review 中已删除文件不再进入读取失败或修复流程', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const deletedFile = 'docs/example/plans/2026-06-24-memory-telemetry-plan.md';
    const discussion: Discussion = {
      id: 'd-stale-deleted',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: `## 🤖 CI Review · Round 9 · commit a1b2c3d4
### AI 分析
#### 🟢 LOW
- ${deletedFile}:1 | 计划文档已删除 | 无需处理`,
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn(),
      recheckAlreadyFixed: vi.fn(),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue(null),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
    });
    const state = mockOf<MrAgentState>({ interactiveThreads: {}, processedDiscussions: {} });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project',
      undefined,
      'standard',
      'ffffffff'
    );

    expect(brain.decide).not.toHaveBeenCalled();
    expect(brain.recheckAlreadyFixed).not.toHaveBeenCalled();
    expect(actor.applyDecision).toHaveBeenCalledWith(
      mockMR,
      discussion,
      expect.objectContaining({ file: deletedFile, line: 1 }),
      expect.objectContaining({ action: 'ignore', alreadyFixed: true }),
      state
    );
    expect(actor.postSummary).not.toHaveBeenCalled();
    expect(
      state.maintainerThreadState?.['d-stale-deleted']?.decisions[`${deletedFile}:1`]
    ).toMatchObject({
      action: 'ignore',
      alreadyFixed: true,
    });
  });

  it('stale CI Review 无人工评论时先复核当前文件，不复用历史失败或重新提问', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const discussion: Discussion = {
      id: 'd-stale-recheck',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 1,
          author: 'ci-bot',
          body: `## 🤖 CI Review · Round 9 · commit a1b2c3d4
### AI 分析
#### 🟢 LOW
- src/index.ts:2 | 旧 finding 已在后续提交中处理 | 无需修改
- src/other.ts:4 | 旧 finding 已在后续提交中处理 | 无需修改`,
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn(),
      recheckAlreadyFixed: vi.fn().mockResolvedValue({
        alreadyFixed: true,
        reason: '当前完整文件中已不存在该问题',
        evidence: '后续提交已满足原 finding',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockImplementation(async file => file),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'current implementation',
        snippetStartLine: 1,
        snippetEndLine: 5,
        totalLines: 5,
        truncated: false,
        targetLine: 2,
      }),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      maintainerThreadState: {
        'd-stale-recheck': {
          decisions: {
            'src/index.ts:2': {
              action: 'fix',
              reason: '旧失败',
              failedAttempts: 3,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project',
      undefined,
      'standard',
      'ffffffff'
    );

    expect(brain.recheckAlreadyFixed).toHaveBeenCalledTimes(2);
    expect(brain.decide).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(actor.postSummary).toHaveBeenCalledWith(
      mockMR,
      discussion,
      [],
      [],
      [],
      [],
      [
        { fileLine: 'src/index.ts:2', reason: '后续提交已满足原 finding' },
        { fileLine: 'src/other.ts:4', reason: '后续提交已满足原 finding' },
      ],
      state,
      []
    );
    expect(state.maintainerThreadState?.['d-stale-recheck']?.decisions).toMatchObject({
      'src/index.ts:2': { action: 'ignore', alreadyFixed: true },
      'src/other.ts:4': { action: 'ignore', alreadyFixed: true },
    });
  });

  it('首条 Reviewer note 作者无法识别为 bot 时仍执行 stale already-fixed 复核', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const finding: ReviewFinding = {
      severity: 'LOW',
      file: 'src/app.ts',
      line: 20,
      message: 'the old finding was handled by a later commit',
      suggestion: 'do not modify it again',
    };
    const discussion: Discussion = {
      id: 'd-note-stale-recheck',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 99,
          author: 'GITLAB_TOKEN',
          body: `LOW\n\n${finding.file}:${finding.line} | ${finding.message} | ${finding.suggestion}`,
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
        {
          id: 100,
          author: 'developer',
          body: `✅ CodeKeeper Maintainer 已根据 Reviewer 的意见自动修复并推送至本分支。\n\n请 Reviewer 复核变更。\n\n---\n*生成于 2026/7/14 · CodeKeeper Advance MR 维护 Agent · maintainer*`,
          createdAt: '2026-07-14T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([finding]),
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      decide: vi.fn(),
      recheckAlreadyFixed: vi.fn().mockResolvedValue({
        alreadyFixed: true,
        reason: 'the problem no longer exists in the current file',
        evidence: 'a later commit contains the fix',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockImplementation(async file => file),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'current implementation',
        snippetStartLine: 1,
        snippetEndLine: 30,
        totalLines: 30,
        truncated: false,
        targetLine: finding.line,
      }),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      reviewState: {
        'feature/test:main': {
          findingsHash: 'hash',
          findingsKeys: [`${finding.file}:${finding.line}`],
          reviewedAt: 2,
          headSha: 'ffffffff',
          summaryNoteId: discussion.notes[0].id,
          reviewNoteIds: [discussion.notes[0].id],
          reviewNoteHeadShas: { [String(discussion.notes[0].id)]: 'a1b2c3d4' },
        },
      },
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            [`${finding.file}:12`]: {
              action: 'fix',
              reason: '旧行号对应的问题此前已经修复',
              failedAttempts: 0,
              fixSucceeded: true,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project',
      undefined,
      'standard',
      'ffffffff'
    );

    expect(brain.recheckAlreadyFixed).toHaveBeenCalledOnce();
    expect(brain.decide).not.toHaveBeenCalled();
    expect(actor.postSummary).not.toHaveBeenCalled();
    expect(actor.applyDecision).toHaveBeenCalledWith(
      mockMR,
      discussion,
      finding,
      expect.objectContaining({
        action: 'ignore',
        alreadyFixed: true,
        replyBody: 'a later commit contains the fix',
      }),
      state
    );
    expect(state.maintainerThreadState?.[discussion.id]?.decisions).toMatchObject({
      [`${finding.file}:${finding.line}`]: { action: 'ignore', alreadyFixed: true },
    });
    expect(state.maintainerThreadState?.[discussion.id]?.lastProcessedHeadSha).toBe('ffffffff');
  });

  it('reruns an exhausted stale fix with the full current file', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const finding: ReviewFinding = {
      severity: 'LOW',
      file: 'src/app.ts',
      line: 20,
      message: 'the current implementation still needs a fix',
      suggestion: 'apply the updated fix',
    };
    const discussion: Discussion = {
      id: 'd-stale-fix-retry',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 101,
          author: 'review-bot',
          body: `LOW\n\n${finding.file}:${finding.line} | ${finding.message} | ${finding.suggestion}`,
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const fullFile = 'export function currentImplementation() {\n  return true;\n}\n';
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([finding]),
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      recheckAlreadyFixed: vi.fn().mockResolvedValue({
        alreadyFixed: false,
        reason: 'the finding still applies',
      }),
      decide: vi.fn().mockResolvedValue({
        action: 'fix',
        reason: 'the latest file can now be fixed',
        fixDescription: 'update the current implementation',
        scope: 'local',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue(true),
      postSummary: vi.fn(),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue(finding.file),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'return false;',
        snippetStartLine: 18,
        snippetEndLine: 22,
        totalLines: 30,
        truncated: true,
        targetLine: finding.line,
      }),
      readFile: vi.fn().mockResolvedValue(fullFile),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      reviewState: {
        'feature/test:main': {
          findingsHash: 'hash',
          findingsKeys: [`${finding.file}:${finding.line}`],
          reviewedAt: 2,
          headSha: 'ffffffff',
          summaryNoteId: discussion.notes[0].id,
          reviewNoteIds: [discussion.notes[0].id],
          reviewNoteHeadShas: { [String(discussion.notes[0].id)]: 'a1b2c3d4' },
        },
      },
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            [`${finding.file}:${finding.line}`]: {
              action: 'fix',
              reason: 'previous attempts made no progress',
              failedAttempts: 3,
              fixSucceeded: false,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project',
      undefined,
      'standard',
      'ffffffff'
    );

    expect(brain.recheckAlreadyFixed).toHaveBeenCalledOnce();
    expect(worktreeManager.readFile).toHaveBeenCalledWith(finding.file);
    expect(brain.decide).toHaveBeenCalledWith(
      expect.objectContaining({ fileContent: fullFile, staleFinding: true })
    );
    expect(actor.applyDecision).toHaveBeenCalledOnce();
    expect(state.maintainerThreadState?.[discussion.id]?.decisions).toMatchObject({
      [`${finding.file}:${finding.line}`]: {
        action: 'fix',
        failedAttempts: 0,
        fixSucceeded: true,
      },
    });
  });

  it('replaces a stale clarification decision instead of repeating it', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });
    const finding: ReviewFinding = {
      severity: 'LOW',
      file: 'src/app.ts',
      line: 58,
      message: 'verify whether the exported type is still misleading',
      suggestion: 'use the current file as the source of truth',
    };
    const discussion: Discussion = {
      id: 'd-stale-ask-recheck',
      resolvable: true,
      resolved: false,
      notes: [
        {
          id: 102,
          author: 'review-bot',
          body: `LOW\n\n${finding.file}:${finding.line} | ${finding.message} | ${finding.suggestion}`,
          createdAt: '2026-07-08T00:00:00Z',
          resolved: false,
        },
      ],
    };
    const fullFile = 'export interface PublicParams { value: string }\n';
    const brain = mockOf<MaintainerBrain>({
      parseFindings: vi.fn().mockResolvedValue([finding]),
      enrichFindingsWithCases: vi.fn().mockImplementation(async findings => findings),
      recheckAlreadyFixed: vi.fn().mockResolvedValue({
        alreadyFixed: false,
        reason: 'a fresh decision is required',
      }),
      decide: vi.fn().mockResolvedValue({
        action: 'ignore',
        alreadyFixed: true,
        reason: 'the full current file disproves the old comment mismatch',
        replyBody: 'the current declaration and comment are consistent',
        scope: 'local',
      }),
    });
    const actor = mockOf<MaintainerActor>({
      applyDecision: vi.fn().mockResolvedValue(true),
      postSummary: vi.fn(),
    });
    const provider = mockOf<GitLabProvider>({ getMRDiff: vi.fn().mockResolvedValue([]) });
    const worktreeManager = mockOf<WorktreeManager>({
      ensureWorktree: vi.fn().mockResolvedValue(undefined),
      checkoutBranch: vi.fn().mockResolvedValue(undefined),
      resolveFilePath: vi.fn().mockResolvedValue(finding.file),
      getWorktreePath: vi.fn().mockReturnValue('/worktree'),
      readFileWindow: vi.fn().mockResolvedValue({
        imports: '',
        snippet: 'export interface PublicParams',
        snippetStartLine: 55,
        snippetEndLine: 60,
        totalLines: 80,
        truncated: true,
        targetLine: finding.line,
      }),
      readFile: vi.fn().mockResolvedValue(fullFile),
    });
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      processedDiscussions: {},
      reviewState: {
        'feature/test:main': {
          findingsHash: 'hash',
          findingsKeys: [`${finding.file}:${finding.line}`],
          reviewedAt: 2,
          headSha: 'ffffffff',
          summaryNoteId: discussion.notes[0].id,
          reviewNoteIds: [discussion.notes[0].id],
          reviewNoteHeadShas: { [String(discussion.notes[0].id)]: 'a1b2c3d4' },
        },
      },
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            [`${finding.file}:${finding.line}`]: {
              action: 'ask',
              reason: 'the file content was unavailable',
              question: 'please provide the full file',
              failedAttempts: 0,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastHumanNoteAt: 0,
        },
      },
    });

    await runner.processDiscussion(
      mockMR,
      discussion,
      provider,
      brain,
      actor,
      worktreeManager,
      'CodeKeeper Maintainer',
      state,
      '/project',
      undefined,
      'standard',
      'ffffffff'
    );

    expect(brain.recheckAlreadyFixed).toHaveBeenCalledOnce();
    expect(brain.decide).toHaveBeenCalledWith(
      expect.objectContaining({ fileContent: fullFile, staleFinding: true })
    );
    expect(actor.applyDecision).toHaveBeenCalledWith(
      mockMR,
      discussion,
      finding,
      expect.objectContaining({ action: 'ignore', alreadyFixed: true }),
      state
    );
    expect(state.maintainerThreadState?.[discussion.id]?.decisions).toMatchObject({
      [`${finding.file}:${finding.line}`]: {
        action: 'ignore',
        alreadyFixed: true,
        failedAttempts: 0,
      },
    });
  });
});

describe('hasHeadChangedSinceProcessing', () => {
  it('rechecks exhausted failures after the MR HEAD changes', () => {
    const discussion: Discussion = {
      id: 'd-head-changed',
      resolvable: true,
      resolved: false,
      notes: [],
    };
    const state = mockOf<MrAgentState>({
      interactiveThreads: {},
      maintainerThreadState: {
        [discussion.id]: {
          decisions: {
            'src/app.ts:20': {
              action: 'fix',
              reason: 'no progress',
              failedAttempts: 3,
              decidedAt: 1,
            },
          },
          lastReviewerNoteAt: 0,
          lastProcessedHeadSha: 'a1b2c3d4',
        },
      },
    });

    expect(hasHeadChangedSinceProcessing(discussion, state, 'ffffffff')).toBe(true);
    expect(hasHeadChangedSinceProcessing(discussion, state, 'a1b2c3d4')).toBe(false);
  });
});

describe('classifyBatchFixItems', () => {
  it('batch 整体成功时按 appliedFiles 标记 fixed', () => {
    const { fixedItems, failedItems } = classifyBatchFixItems(
      [
        { file: 'src/a.ts', line: 1 },
        { file: 'src/b.ts', line: 2 },
      ],
      { success: true, reason: 'ok', appliedFiles: ['src/a.ts'], deletedFiles: [] }
    );

    expect(fixedItems).toEqual(['src/a.ts:1']);
    expect(failedItems).toHaveLength(1);
    expect(failedItems[0]).toContain('src/b.ts:2');
  });

  it('batch 失败时即使文件在 appliedFiles 中也不算 fixed（未推送）', () => {
    const { fixedItems, failedItems } = classifyBatchFixItems(
      [
        { file: 'src/a.ts', line: 1 },
        { file: 'src/b.ts', line: 2 },
      ],
      {
        success: false,
        reason: '后续 finding 修复失败',
        appliedFiles: ['src/a.ts'],
        deletedFiles: [],
      }
    );

    expect(fixedItems).toEqual([]);
    expect(failedItems).toHaveLength(2);
    expect(failedItems[0]).toContain('src/a.ts:1');
    expect(failedItems[0]).toContain('后续 finding 修复失败');
  });

  it('deleteFile 项也必须 batch 成功才算 fixed', () => {
    const { fixedItems, failedItems } = classifyBatchFixItems(
      [{ file: 'src/dead.ts', line: 1, deleteFile: true }],
      { success: false, reason: '另一项失败', appliedFiles: [], deletedFiles: ['src/dead.ts'] }
    );

    expect(fixedItems).toEqual([]);
    expect(failedItems[0]).toContain('src/dead.ts:1');
  });

  it('优先使用逐 finding 结果，不把一个失败原因复制给暂缓项', () => {
    const { fixedItems, failedItems, deferredItems } = classifyBatchFixItems(
      [
        { file: 'src/a.ts', line: 1 },
        { file: 'src/b.ts', line: 2 },
        { file: 'src/c.ts', line: 3 },
      ],
      {
        success: false,
        reason: '批量修复未完成',
        appliedFiles: ['src/a.ts'],
        deletedFiles: [],
        itemResults: [
          { file: 'src/a.ts', line: 1, status: 'deferred', reason: '事务尚未提交' },
          { file: 'src/b.ts', line: 2, status: 'failed', reason: '目标函数仍缺少保护' },
          { file: 'src/c.ts', line: 3, status: 'deferred', reason: '本轮尚未执行' },
        ],
      }
    );

    expect(fixedItems).toEqual([]);
    expect(failedItems).toEqual(['src/b.ts:2 — 目标函数仍缺少保护']);
    expect(deferredItems).toEqual(['src/a.ts:1 — 事务尚未提交', 'src/c.ts:3 — 本轮尚未执行']);
  });
});

describe('legacy maintainer state repair', () => {
  it('回复已发布但 resolve 未完成时，源评论更新会淘汰旧投递', () => {
    const generatedAt = Date.parse('2026-08-03T06:00:00.000Z');
    const threadState: MaintainerThreadState = {
      decisions: {},
      lastReviewerNoteAt: generatedAt - 60_000,
      delivery: {
        replyBody: '旧结论',
        replyHash: 'old',
        replyStatus: 'posted',
        replyNoteId: 2,
        resolveRequired: true,
        resolveStatus: 'failed',
        attempts: 1,
        createdAt: generatedAt,
        updatedAt: generatedAt,
      },
    };

    const reason = getDiscussionDeliveryInvalidationReason({
      discussion: {
        id: 'd-updated-before-resolve',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'reviewer-agent',
            body: 'src/a.ts:1 更新后的问题',
            createdAt: new Date(generatedAt - 60_000).toISOString(),
            updatedAt: new Date(generatedAt + 60_000).toISOString(),
            resolved: false,
          },
          {
            id: 2,
            author: 'maintainer',
            body: '旧结论',
            createdAt: new Date(generatedAt).toISOString(),
            resolved: false,
          },
        ],
      },
      threadState,
      now: generatedAt + 120_000,
    });

    expect(reason).toContain('源评论');
  });

  it('按首次生成时间淘汰跨日重试的陈旧超长投递', () => {
    const generatedAt = Date.parse('2026-07-28T06:00:00.000Z');
    const retriedAt = Date.parse('2026-08-03T06:00:00.000Z');
    const threadState: MaintainerThreadState = {
      decisions: {},
      lastReviewerNoteAt: 0,
      lastSummaryAt: generatedAt,
      delivery: {
        replyBody: `\u001b[31m失败\u001b[0m\n${'x'.repeat(430_000)}`,
        replyHash: 'legacy',
        replyStatus: 'failed',
        resolveRequired: false,
        resolveStatus: 'not-required',
        attempts: 3,
        updatedAt: retriedAt,
      },
    };

    const repaired = repairLegacyMaintainerThreadState(threadState, retriedAt);
    const reason = getDiscussionDeliveryInvalidationReason({
      discussion: {
        id: 'd-stale-delivery',
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: 1,
            author: 'reviewer-agent',
            body: 'src/a.ts:1 需要检查边界条件',
            createdAt: '2026-07-28T05:00:00.000Z',
            resolved: false,
          },
        ],
      },
      threadState,
      now: retriedAt,
    });

    expect(repaired.changed).toBe(true);
    expect(threadState.delivery?.createdAt).toBe(generatedAt);
    expect(threadState.delivery?.replyBody.length).toBeLessThanOrEqual(16_000);
    expect(threadState.delivery?.replyBody).not.toContain('\u001b[');
    expect(reason).toContain('超过两小时');
  });

  it('把历史仓库自查型 ask 回流为 fix', () => {
    const threadState: MaintainerThreadState = {
      decisions: {
        'src/a.ts:8': {
          action: 'ask',
          reason: '需要读取实现',
          question: '请提供 src/a.ts 文件的完整内容，以便判断当前实现。',
          failedAttempts: 2,
          decidedAt: 1,
        },
      },
      lastReviewerNoteAt: 0,
    };

    const repaired = repairLegacyMaintainerThreadState(threadState, 100);

    expect(repaired.repairedSelfAnswerableAsk).toBe(true);
    expect(threadState.decisions['src/a.ts:8']).toMatchObject({
      action: 'fix',
      failedAttempts: 0,
    });
    expect(threadState.decisions['src/a.ts:8'].question).toBeUndefined();
  });

  it('把未耗尽重试次数的历史修复失败求助回流为自动重试', () => {
    const question =
      '我尝试自动修复 src/a.ts:8，但未成功。请 Reviewer 补充期望的修改方式或范围，我会再试一次。';
    const threadState: MaintainerThreadState = {
      decisions: {
        'src/a.ts:8': {
          action: 'fix',
          reason: '需要修复',
          question,
          failedAttempts: 1,
          fixSucceeded: false,
          lastFailureReason: '首次修复未完成',
          decidedAt: 1,
        },
      },
      lastReviewerNoteAt: 0,
      repairVersion: 1,
      delivery: {
        replyBody: question,
        replyHash: 'legacy',
        replyStatus: 'posted',
        resolveRequired: false,
        resolveStatus: 'not-required',
        attempts: 1,
        awaitingReply: true,
        awaitingReplyAt: 1,
        question,
        filePath: 'src/a.ts',
        updatedAt: 1,
      },
    };

    const repaired = repairLegacyMaintainerThreadState(threadState, 100);

    expect(repaired.repairedPrematureFixAsk).toBe(true);
    expect(threadState.decisions['src/a.ts:8']).toMatchObject({
      action: 'fix',
      failedAttempts: 1,
      fixSucceeded: false,
    });
    expect(threadState.decisions['src/a.ts:8'].question).toBeUndefined();
    expect(threadState.delivery?.awaitingReply).toBe(false);
    expect(threadState.repairVersion).toBe(2);
  });
});
