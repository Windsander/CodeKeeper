import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSuggestions } from '../../../src/advance/codekeeper/suggestions-writer';
import type { ArchiveAction } from '../../../src/advance/types';

describe('writeSuggestions', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-sug-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应写入 suggestions.md', () => {
    const actions: ArchiveAction[] = [
      { id: 'a1', sourcePath: '/x.md', type: 'move', reason: '移到 docs', targetPath: '/docs/x.md', risk: 'medium', confidence: 0.7, createdAt: 1 },
    ];
    writeSuggestions({ projectRoot: tmp, actions });
    const content = readFileSync(join(tmp, '.codekeeper', 'suggestions.md'), 'utf-8');
    expect(content).toContain('# 归档建议');
    expect(content).toContain('移到 docs');
    expect(content).toContain('/docs/x.md');
    expect(content).toContain('风险等级：medium');
  });

  it('actions 为空时应显示提示', () => {
    writeSuggestions({ projectRoot: tmp, actions: [] });
    const content = readFileSync(join(tmp, '.codekeeper', 'suggestions.md'), 'utf-8');
    expect(content).toContain('# 归档建议');
    expect(content).toContain('当前没有待处理的归档建议。');
  });
});
