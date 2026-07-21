import { describe, it, expect, vi } from 'vitest';
import { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { RunScriptResult } from '../../../../src/advance/classic/worktree/worktree-manager.js';

describe('WorktreeManager.runSetupCommand', () => {
  it('使用自定义 runner 执行 setup 命令', async () => {
    const runner = vi.fn().mockResolvedValue({ success: true } as RunScriptResult);
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath: '/tmp/project',
      remoteUrl: 'https://example.com/repo.git',
      runSetupCommand: runner,
    });

    const result = await manager.runSetupCommand('npm install', 'packages/foo');
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith('npm install', expect.stringMatching(/packages[\\/]foo/));
  });
});
