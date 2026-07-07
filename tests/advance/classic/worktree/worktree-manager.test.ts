import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager, WorktreeError } from '../../../../src/advance/classic/worktree/worktree-manager.js';

describe('WorktreeManager.validate', () => {
  it('返回 lint/typecheck 失败原因', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath: '/tmp/p1',
      remoteUrl: 'https://example.com/p1.git',
      runScript: async (script) =>
        script === 'lint'
          ? { success: false, reason: 'eslint error' }
          : { success: true },
    });

    const result = await manager.validate();
    expect(result.lint).toBe(false);
    expect(result.typecheck).toBe(true);
    expect(result.lintReason).toBe('eslint error');
  });
});

describe('WorktreeError', () => {
  it('包含 stage 信息', () => {
    const err = new WorktreeError('checkout', new Error('branch not found'));
    expect(err.stage).toBe('checkout');
    expect(err.message).toContain('branch not found');
  });
});
