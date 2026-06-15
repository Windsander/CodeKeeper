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

  it('应自动执行 low risk 的 move 动作', async () => {
    const source = join(tmp, 'draft.md');
    const target = join(tmp, 'docs', 'specs', 'a.md');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(source, '# 测试', 'utf-8');

    const action: ArchiveAction = {
      id: 'a1',
      entryId: source,
      type: 'move',
      reason: '归档',
      targetPath: target,
      risk: 'low',
      confidence: 0.9,
      createdAt: Date.now(),
    };

    const executor = new ArchiveExecutor({ projectRoot: tmp });
    const result = await executor.execute(action);
    expect(result.success).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('# 测试');
  });

  it('应跳过 medium/high risk 动作', async () => {
    const source = join(tmp, 'draft.md');
    writeFileSync(source, 'x', 'utf-8');
    const action: ArchiveAction = {
      id: 'a2',
      entryId: source,
      type: 'move',
      reason: '需要确认',
      targetPath: join(tmp, 'b.md'),
      risk: 'medium',
      confidence: 0.6,
      createdAt: Date.now(),
    };
    const executor = new ArchiveExecutor({ projectRoot: tmp });
    const result = await executor.execute(action);
    expect(result.success).toBe(false);
    expect(result.skipped).toBe(true);
    expect(existsSync(source)).toBe(true);
  });
});
