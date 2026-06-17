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

  it('应写入 suggestions.md 动作日志', () => {
    const actions: ArchiveAction[] = [
      { id: 'a1', sourcePath: '/x.md', type: 'copy', reason: '复制到 docs', targetPath: '/docs/x.md', risk: 'medium', confidence: 0.7, createdAt: 1 },
    ];
    const archiveRoot = join(tmp, '.codekeeper');
    writeSuggestions({ projectRoot: tmp, archiveRoot, actions });
    const content = readFileSync(join(archiveRoot, 'suggestions.md'), 'utf-8');
    expect(content).toContain('# 归档动作日志');
    expect(content).toContain('复制到 docs');
    expect(content).toContain('动作：copy');
    expect(content).toContain('风险等级：medium');
    expect(content).toContain('ID：a1');
  });

  it('actions 为空时应显示提示', () => {
    const archiveRoot = join(tmp, '.codekeeper');
    writeSuggestions({ projectRoot: tmp, archiveRoot, actions: [] });
    const content = readFileSync(join(archiveRoot, 'suggestions.md'), 'utf-8');
    expect(content).toContain('# 归档动作日志');
    expect(content).toContain('当前没有归档动作记录。');
  });

  it('应按风险等级分组并按时间降序', () => {
    const actions: ArchiveAction[] = [
      { id: 'h1', sourcePath: '/h1.md', type: 'copy', reason: '高 1', targetPath: '/a/h1.md', risk: 'high', confidence: 0.8, createdAt: 100 },
      { id: 'h2', sourcePath: '/h2.md', type: 'copy', reason: '高 2', targetPath: '/a/h2.md', risk: 'high', confidence: 0.95, createdAt: 200 },
      { id: 'm1', sourcePath: '/m1.md', type: 'copy', reason: '中 1', targetPath: '/a/m1.md', risk: 'medium', confidence: 0.7, createdAt: 50 },
    ];
    const archiveRoot = join(tmp, '.codekeeper');
    writeSuggestions({ projectRoot: tmp, archiveRoot, actions });
    const content = readFileSync(join(archiveRoot, 'suggestions.md'), 'utf-8');
    const highIndex = content.indexOf('## 高 风险');
    const mediumIndex = content.indexOf('## 中 风险');
    const h1Index = content.indexOf('h1.md');
    const h2Index = content.indexOf('h2.md');
    expect(highIndex).toBeLessThan(mediumIndex);
    expect(h2Index).toBeLessThan(h1Index);
  });
});
