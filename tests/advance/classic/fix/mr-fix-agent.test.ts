import { describe, it, expect, vi } from 'vitest';
import { MrFixAgent } from '../../../../src/advance/classic/fix/mr-fix-agent.js';
import { WorktreeError } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { MergeRequest, ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function createMockWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    ensureWorktree: vi.fn().mockResolvedValue(undefined),
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    prepareEnvironment: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockReturnValue('original'),
    writeFile: vi.fn().mockReturnValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    ...overrides,
  } as unknown as WorktreeManager;
}

function createMockLlmClient(response: string | null): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: { response: response ?? '' },
  });
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
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient('fixed content'),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(true);
    expect(worktree.checkoutBranch).toHaveBeenCalledWith('feature/test');
    expect(worktree.prepareEnvironment).toHaveBeenCalled();
    expect(worktree.writeFile).toHaveBeenCalledWith('src/index.ts', 'fixed content');
    expect(worktree.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringContaining('[CodeKeeper] fix'),
      { setUpstream: false }
    );
  });

  it('校验失败时返回失败', async () => {
    const worktree = createMockWorktreeManager({
      validate: vi.fn().mockResolvedValue({ lint: false, typecheck: true }),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient('fixed content'),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('校验未通过');
    expect(worktree.commitAndPush).not.toHaveBeenCalled();
  });

  it('LLM 返回空时返回失败', async () => {
    const worktree = createMockWorktreeManager();
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(null),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('LLM 未生成有效修复代码');
    expect(worktree.writeFile).not.toHaveBeenCalled();
  });

  it('执行异常时返回失败原因', async () => {
    const worktree = createMockWorktreeManager({
      ensureWorktree: vi.fn().mockRejectedValue(new Error('worktree 异常')),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient('fixed content'),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('worktree 异常');
  });

  it('校验失败返回具体原因', async () => {
    const worktree = createMockWorktreeManager({
      validate: vi.fn().mockResolvedValue({
        lint: false,
        typecheck: true,
        lintReason: 'eslint error',
      }),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient('fixed content'),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('校验未通过');
    expect(result.reason).toContain('eslint error');
  });

  it('worktree clone 失败返回阶段信息', async () => {
    const worktree = createMockWorktreeManager({
      ensureWorktree: vi.fn().mockRejectedValue(new WorktreeError('clone', new Error('auth failed'))),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient('fixed content'),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('clone');
    expect(result.reason).toContain('auth failed');
  });
});
