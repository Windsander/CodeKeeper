import { describe, it, expect, vi } from 'vitest';
import { MaintainerRunner, classifyBatchFixItems } from '../../../../src/advance/classic/runners/maintainer-runner.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { MergeRequest, Discussion, ReviewFinding } from '../../../../src/advance/classic/provider/types.js';
import type { MaintainerBrain } from '../../../../src/advance/classic/fix/maintainer-brain.js';
import type { MaintainerActor } from '../../../../src/advance/classic/fix/maintainer-actor.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { MrAgentState } from '../../../../src/advance/classic/runners/shared/state-utils.js';

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

const mockFinding: ReviewFinding = {
  severity: 'MEDIUM',
  file: 'src/index.ts',
  line: 2,
  message: '变量未使用',
  suggestion: '删除',
  autoFixable: true,
};

describe('MaintainerRunner', () => {
  it('调用 brain.decide 时传入 mrContext 与 relatedFindings', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = {
      getMRDiff: vi.fn().mockResolvedValue([
        { filePath: 'src/index.ts', additions: 1, deletions: 0, oldPath: 'src/index.ts', newPath: 'src/index.ts', newFile: false, deletedFile: false, diff: '' },
      ]),
    };

    const brain = {
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
    } as unknown as MaintainerBrain;

    const actor = {
      applyDecision: vi.fn().mockResolvedValue(undefined),
    } as unknown as MaintainerActor;

    const worktreeManager = {
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
    } as unknown as WorktreeManager;

    const state: MrAgentState = {
      interactiveThreads: {},
      processedDiscussions: {},
    } as MrAgentState;

    await (runner as unknown as Record<string, unknown>).processDiscussion(
      mockMR,
      mockDiscussion,
      provider as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider,
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
    const memoryClient = { recordProjectKnowledge } as unknown as import('../../../../src/advance/classic/memory/memory-client.js').MemoryClient;

    const brain = {
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'record',
        reason: '纯统计报告',
        memoryCategory: 'risk',
        memoryContent: 'ESLint delta: Warning -1',
      }),
    } as unknown as MaintainerBrain;

    const actor = {
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    } as unknown as MaintainerActor;

    const provider = {
      addDiscussionNote: vi.fn(),
      getMRDiff: vi.fn().mockResolvedValue([]),
    } as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider;

    const state: MrAgentState = {
      interactiveThreads: {},
      processedDiscussions: {},
    } as MrAgentState;

    await (runner as unknown as Record<string, unknown>).processDiscussion(
      mockMR,
      statsDiscussion,
      provider,
      brain,
      actor,
      {} as unknown as WorktreeManager,
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

    const brain = {
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ask',
        reason: '缺少文件路径',
        question: '请补充具体文件和行号',
      }),
    } as unknown as MaintainerBrain;

    const actor = {
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    } as unknown as MaintainerActor;

    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    } as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider;

    const state: MrAgentState = {
      interactiveThreads: {},
      processedDiscussions: {},
    } as MrAgentState;

    await (runner as unknown as Record<string, unknown>).processDiscussion(
      mockMR,
      vagueDiscussion,
      provider,
      brain,
      actor,
      {} as unknown as WorktreeManager,
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

    const brain = {
      parseFindings: vi.fn().mockResolvedValue([]),
      enrichFindingsWithCases: vi.fn(),
      decide: vi.fn(),
      decideNonFindingComment: vi.fn().mockResolvedValue({
        action: 'ignore',
        reason: 'Reviewer 已确认可接受',
        replyBody: '👍 感谢 Reviewer 的确认，这些点我已核对，无需额外修改。',
      }),
    } as unknown as MaintainerBrain;

    const actor = {
      applyDecision: vi.fn(),
      postSummary: vi.fn(),
    } as unknown as MaintainerActor;

    const provider = {
      addDiscussionNote: vi.fn().mockResolvedValue(undefined),
      getMRDiff: vi.fn().mockResolvedValue([]),
    } as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider;

    const state: MrAgentState = {
      interactiveThreads: {},
      processedDiscussions: {},
    } as MrAgentState;

    await (runner as unknown as Record<string, unknown>).processDiscussion(
      mockMR,
      praiseDiscussion,
      provider,
      brain,
      actor,
      {} as unknown as WorktreeManager,
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

  it('单条 finding 已标记为已修复且无新回复时不再重复处理', async () => {
    const runner = new MaintainerRunner({ llmClient: makeLlmClient() });

    const provider = {
      getMRDiff: vi.fn().mockResolvedValue([
        { filePath: 'src/index.ts', additions: 1, deletions: 0, oldPath: 'src/index.ts', newPath: 'src/index.ts', newFile: false, deletedFile: false, diff: '' },
      ]),
    };

    const brain = {
      parseFindings: vi.fn().mockResolvedValue([mockFinding]),
      enrichFindingsWithCases: vi.fn().mockResolvedValue([mockFinding]),
      decide: vi.fn(),
    } as unknown as MaintainerBrain;

    const actor = {
      applyDecision: vi.fn(),
    } as unknown as MaintainerActor;

    const worktreeManager = {
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
    } as unknown as WorktreeManager;

    const state: MrAgentState = {
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
        },
      },
    } as MrAgentState;

    await (runner as unknown as Record<string, unknown>).processDiscussion(
      mockMR,
      mockDiscussion,
      provider as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider,
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
      { success: false, reason: '后续 finding 修复失败', appliedFiles: ['src/a.ts'], deletedFiles: [] }
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
});
