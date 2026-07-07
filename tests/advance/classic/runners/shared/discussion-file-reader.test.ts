import { describe, it, expect, vi } from 'vitest';
import { readDiscussionFileContent } from '../../../../../src/advance/classic/runners/shared/discussion-file-reader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('readDiscussionFileContent', () => {
  it('worktree 失败时回退到项目根目录', async () => {
    const root = join(tmpdir(), `ck-test-${Date.now()}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'const x = 1;', 'utf-8');

    const worktreeManager = {
      ensureWorktree: vi.fn().mockRejectedValue(new Error('clone failed')),
      checkoutBranch: vi.fn(),
      readFile: vi.fn(),
    };

    const content = await readDiscussionFileContent(
      worktreeManager as any,
      root,
      'src/a.ts',
      'feature'
    );
    expect(content).toBe('const x = 1;');

    rmSync(root, { recursive: true, force: true });
  });

  it('都失败时返回 null', async () => {
    const root = join(tmpdir(), `ck-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });

    const worktreeManager = {
      ensureWorktree: vi.fn().mockRejectedValue(new Error('clone failed')),
      checkoutBranch: vi.fn(),
      readFile: vi.fn(),
    };

    const content = await readDiscussionFileContent(
      worktreeManager as any,
      root,
      'not-exist.ts',
      'feature'
    );
    expect(content).toBeNull();

    rmSync(root, { recursive: true, force: true });
  });
});
