import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ArchiveExecutor } from '../../../src/advance/archive/archive-executor';
import type { ArchiveAction } from '../../../src/advance/types';

describe('ArchiveExecutor', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-exec-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应执行 low risk 的 copy 动作并保留原文件', async () => {
    const source = join(tmp, 'draft.md');
    const target = join(tmp, 'docs', 'specs', 'a.md');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(source, '# 测试', 'utf-8');

    const action: ArchiveAction = {
      id: 'a1',
      sourcePath: source,
      type: 'copy',
      reason: '归档',
      targetPath: target,
      risk: 'low',
      confidence: 0.9,
      createdAt: Date.now(),
    };

    const executor = new ArchiveExecutor({ archiveRoot: tmp });
    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('# 测试');
  });

  it('目标路径越界时应失败', async () => {
    const source = join(tmp, 'draft.md');
    writeFileSync(source, 'x', 'utf-8');
    const action: ArchiveAction = {
      id: 'a2',
      sourcePath: source,
      type: 'copy',
      reason: '越界',
      targetPath: join(tmp, '..', 'b.md'),
      risk: 'medium',
      confidence: 0.6,
      createdAt: Date.now(),
    };
    const executor = new ArchiveExecutor({ archiveRoot: tmp });
    const result = await executor.execute(action);
    expect(result.success).toBe(false);
    expect(result.error).toContain('归档根目录');
  });
});
