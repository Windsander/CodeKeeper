import { describe, it, expect, vi } from 'vitest';
import { MaintainerRunner } from '../../../../src/advance/classic/runners/maintainer-runner.js';
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
});
