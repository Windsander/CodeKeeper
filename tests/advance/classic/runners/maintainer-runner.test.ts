import { describe, it, expect, vi } from 'vitest';
import {
  MaintainerRunner,
  classifyBatchFixItems,
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
import type { MrAgentState } from '../../../../src/advance/classic/runners/shared/state-utils.js';
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

  it('批量统计报告（如 ESLint 全局报告）被识别后静默跳过，不修复不回复', async () => {
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

    expect(brain.isStatisticalReport).toHaveBeenCalled();
    expect(brain.enrichFindingsWithCases).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-report']).toBeDefined();
    expect(state.maintainerThreadState?.['d-report']?.statisticalReport).toBe(true);
  });

  it('批量统计报告（如 ESLint 全局报告）被识别后静默跳过，不修复不回复', async () => {
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

    expect(brain.isStatisticalReport).toHaveBeenCalled();
    expect(brain.enrichFindingsWithCases).not.toHaveBeenCalled();
    expect(actor.applyDecision).not.toHaveBeenCalled();
    expect(state.processedDiscussions?.['d-report']).toBeDefined();
    expect(state.maintainerThreadState?.['d-report']?.statisticalReport).toBe(true);
  });

  it('空格分隔的 ESLint 全局报告解析为聚合条目后判定静默跳过', async () => {
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

    expect(brain.isStatisticalReport).toHaveBeenCalledWith(reportDiscussion.notes[0].body);
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
          body: 'CI Review 报告（统计 + 分析）',
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
    expect(actor.applyDecision).not.toHaveBeenCalled();
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
    expect(actor.postSummary).not.toHaveBeenCalled();
    expect(state.maintainerThreadState?.['d-stale-recheck']?.decisions).toMatchObject({
      'src/index.ts:2': { action: 'ignore', alreadyFixed: true },
      'src/other.ts:4': { action: 'ignore', alreadyFixed: true },
    });
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
});
