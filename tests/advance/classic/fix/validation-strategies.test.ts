import { describe, it, expect, vi } from 'vitest';
import {
  WorkspaceValidationStrategy,
  ErrorDeltaValidationStrategy,
} from '../../../../src/advance/classic/fix/validation-strategy.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';

describe('WorkspaceValidationStrategy', () => {
  it('lint 和 typecheck 都通过时返回 passed', async () => {
    const strategy = new WorkspaceValidationStrategy();
    const worktreeManager = {
      validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    } as unknown as WorktreeManager;
    const result = await strategy.evaluate({ worktreeManager, appliedFiles: [], deletedFiles: [] });
    expect(result.passed).toBe(true);
  });

  it('typecheck 失败时返回未通过', async () => {
    const strategy = new WorkspaceValidationStrategy();
    const worktreeManager = {
      validate: vi.fn().mockResolvedValue({
        lint: true,
        typecheck: false,
        typecheckReason: 'error TS123',
      }),
    } as unknown as WorktreeManager;
    const result = await strategy.evaluate({ worktreeManager, appliedFiles: [], deletedFiles: [] });
    expect(result.passed).toBe(false);
  });

  it('优先使用传入的 rawResult', async () => {
    const strategy = new WorkspaceValidationStrategy();
    const worktreeManager = {
      validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    } as unknown as WorktreeManager;
    const result = await strategy.evaluate({
      worktreeManager,
      appliedFiles: [],
      deletedFiles: [],
      rawResult: { lint: false, typecheck: true, lintReason: 'error' },
    });
    expect(result.passed).toBe(false);
    expect(worktreeManager.validate).not.toHaveBeenCalled();
  });
});

describe('ErrorDeltaValidationStrategy', () => {
  it('首次调用建立基线并返回 passed', async () => {
    const strategy = new ErrorDeltaValidationStrategy();
    const worktreeManager = {
      validate: vi.fn().mockResolvedValue({
        lint: true,
        typecheck: false,
        typecheckReason: 'error TS123',
      }),
    } as unknown as WorktreeManager;
    const result = await strategy.evaluate({ worktreeManager, appliedFiles: [], deletedFiles: [] });
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('基线');
  });

  it('错误数未增加时通过', async () => {
    const strategy = new ErrorDeltaValidationStrategy();
    const worktreeManager = {
      validate: vi.fn().mockResolvedValue({
        lint: true,
        typecheck: false,
        typecheckReason: 'error TS123',
      }),
    } as unknown as WorktreeManager;
    const baseline = await strategy.evaluate({ worktreeManager, appliedFiles: [], deletedFiles: [] });
    const result = await strategy.evaluate({
      worktreeManager,
      appliedFiles: ['src/a.ts'],
      deletedFiles: [],
      rawResult: { lint: true, typecheck: false, typecheckReason: 'error TS123' },
      baseline,
    });
    expect(result.passed).toBe(true);
  });

  it('错误数增加时不通过', async () => {
    const strategy = new ErrorDeltaValidationStrategy();
    const worktreeManager = {
      validate: vi.fn().mockResolvedValue({
        lint: true,
        typecheck: false,
        typecheckReason: 'error TS123',
      }),
    } as unknown as WorktreeManager;
    const baseline = await strategy.evaluate({ worktreeManager, appliedFiles: [], deletedFiles: [] });
    const result = await strategy.evaluate({
      worktreeManager,
      appliedFiles: ['src/a.ts'],
      deletedFiles: [],
      rawResult: { lint: true, typecheck: false, typecheckReason: 'error TS123\nerror TS456' },
      baseline,
    });
    expect(result.passed).toBe(false);
  });
});
