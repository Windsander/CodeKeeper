import { describe, it, expect, vi } from 'vitest';
import { MrFixAgent } from '../../../../src/advance/classic/fix/mr-fix-agent.js';
import { FixDecisionEngine } from '../../../../src/advance/classic/fix/fix-decision-engine.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { ClassicReviewer } from '../../../../src/advance/classic/review/reviewer.js';
import type { MergeRequest, ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function createMockWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    ensureWorktree: vi.fn().mockResolvedValue(undefined),
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockReturnValue('original'),
    writeFile: vi.fn().mockReturnValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    ...overrides,
  } as unknown as WorktreeManager;
}

function createMockReviewer(fixResponse: string | null): ClassicReviewer {
  return {
    generateFix: vi.fn().mockResolvedValue(fixResponse),
  } as unknown as ClassicReviewer;
}

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

const mockFinding: ReviewFinding = {
  severity: 'HIGH',
  file: 'src/index.ts',
  line: 10,
  ruleId: 'RULE-001',
  message: '问题描述',
  suggestion: '修改建议',
  autoFixable: true,
};

describe('MrFixAgent', () => {
  it('成功修复并推送', async () => {
    const worktree = createMockWorktreeManager();
    const reviewer = createMockReviewer('fixed content');
    const agent = new MrFixAgent({ worktreeManager: worktree, reviewer });

    const result = await agent.processFinding(mockFinding, mockMR);

    expect(result.success).toBe(true);
    expect(result.action).toBe('fix');
    expect(worktree.checkoutBranch).toHaveBeenCalledWith('feature/test');
    expect(worktree.writeFile).toHaveBeenCalledWith('src/index.ts', 'fixed content');
    expect(worktree.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringContaining('[CodeKeeper] fix'),
      { setUpstream: false }
    );
  });

  it('不可自动修复时跳过', async () => {
    const worktree = createMockWorktreeManager();
    const reviewer = createMockReviewer('fixed content');
    const decisionEngine = new FixDecisionEngine({ autoFixAutoFixable: false });
    const agent = new MrFixAgent({ worktreeManager: worktree, reviewer, decisionEngine });

    const result = await agent.processFinding(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.action).toBe('defer');
    expect(worktree.checkoutBranch).not.toHaveBeenCalled();
  });

  it('校验失败时 defer', async () => {
    const worktree = createMockWorktreeManager({
      validate: vi.fn().mockResolvedValue({ lint: false, typecheck: true }),
    });
    const reviewer = createMockReviewer('fixed content');
    const agent = new MrFixAgent({ worktreeManager: worktree, reviewer });

    const result = await agent.processFinding(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.action).toBe('defer');
    expect(result.reason).toContain('校验未通过');
    expect(worktree.commitAndPush).not.toHaveBeenCalled();
  });

  it('LLM 返回空时跳过', async () => {
    const worktree = createMockWorktreeManager();
    const reviewer = createMockReviewer(null);
    const agent = new MrFixAgent({ worktreeManager: worktree, reviewer });

    const result = await agent.processFinding(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.action).toBe('skip');
    expect(worktree.writeFile).not.toHaveBeenCalled();
  });
});
