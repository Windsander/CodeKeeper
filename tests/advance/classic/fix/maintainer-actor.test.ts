import { describe, it, expect, vi } from 'vitest';
import { MaintainerActor } from '../../../../src/advance/classic/fix/maintainer-actor.js';
import type { MergeRequest, ReviewFinding, Discussion } from '../../../../src/advance/classic/provider/types.js';
import type { MrFixAgent } from '../../../../src/advance/classic/fix/mr-fix-agent.js';
import type { CognitiveDecision } from '../../../../src/advance/classic/fix/maintainer-brain.js';
import type { MrAgentState } from '../../../../src/advance/classic/runners/shared/state-utils.js';

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test MR',
  description: '',
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
  notes: [],
};

const mockFinding: ReviewFinding = {
  severity: 'MEDIUM',
  file: 'src/index.ts',
  line: 2,
  message: '变量未使用',
  suggestion: '删除',
  autoFixable: true,
};

function createMockProvider() {
  return {
    addDiscussionNote: vi.fn().mockResolvedValue(undefined),
    resolveDiscussion: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider;
}

function createMockFixAgent(overrides: Partial<MrFixAgent> = {}) {
  return {
    executeFix: vi.fn().mockResolvedValue({ success: true, reason: '已推送' }),
    ...overrides,
  } as unknown as MrFixAgent;
}

function createState(): MrAgentState {
  return {
    interactiveThreads: {},
    processedDiscussions: {},
  } as MrAgentState;
}

describe('MaintainerActor', () => {
  it('fix 成功后评论包含 reasoning', async () => {
    const provider = createMockProvider();
    const fixAgent = createMockFixAgent();
    const actor = new MaintainerActor({ provider, fixAgent, maintainerName: 'CodeKeeper Maintainer' });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '可以修复',
      fixDescription: '删除未使用变量',
      analysis: '变量未使用',
      consideredOptions: ['删除', '保留'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    await actor.applyDecision(mockMR, mockDiscussion, mockFinding, decision, createState());

    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('最终决策')
    );
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('删除更干净')
    );
    expect(provider.resolveDiscussion).toHaveBeenCalledWith(mockMR.iid, mockDiscussion.id);
  });

  it('fix 失败时转为 ask', async () => {
    const provider = createMockProvider();
    const fixAgent = createMockFixAgent({
      executeFix: vi.fn().mockResolvedValue({ success: false, reason: 'patch 应用失败' }),
    } as Partial<MrFixAgent>);
    const actor = new MaintainerActor({ provider, fixAgent, maintainerName: 'CodeKeeper Maintainer' });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '尝试修复',
      fixDescription: '删除变量',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'medium',
    };

    await actor.applyDecision(mockMR, mockDiscussion, mockFinding, decision, createState());

    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('未成功')
    );
  });
});
