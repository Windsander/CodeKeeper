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
    expect(content).toContain('docs/x.md');
    expect(content).toContain('风险等级：medium');
    expect(content).toContain('ID：a1');
  });

  it('actions 为空时应显示提示', () => {
    writeSuggestions({ projectRoot: tmp, actions: [] });
    const content = readFileSync(join(tmp, '.codekeeper', 'suggestions.md'), 'utf-8');
    expect(content).toContain('# 归档建议');
    expect(content).toContain('当前没有待处理的归档建议。');
  });

  it('应按风险等级分组并按置信度降序', () => {
    const actions: ArchiveAction[] = [
      { id: 'h1', sourcePath: '/h1.md', type: 'ignore', reason: '高 1', risk: 'high', confidence: 0.8, createdAt: 1 },
      { id: 'h2', sourcePath: '/h2.md', type: 'ignore', reason: '高 2', risk: 'high', confidence: 0.95, createdAt: 1 },
      { id: 'm1', sourcePath: '/m1.md', type: 'move', reason: '中 1', targetPath: '/docs/m1.md', risk: 'medium', confidence: 0.7, createdAt: 1 },
    ];
    writeSuggestions({ projectRoot: tmp, actions });
    const content = readFileSync(join(tmp, '.codekeeper', 'suggestions.md'), 'utf-8');
    const highIndex = content.indexOf('## 高 风险');
    const mediumIndex = content.indexOf('## 中 风险');
    const h1Index = content.indexOf('h1.md');
    const h2Index = content.indexOf('h2.md');
    expect(highIndex).toBeLessThan(mediumIndex);
    expect(h2Index).toBeLessThan(h1Index);
  });

  it('应包含批量操作说明', () => {
    const actions: ArchiveAction[] = [
      { id: 'a1', sourcePath: '/x.md', type: 'move', reason: '移到 docs', targetPath: '/docs/x.md', risk: 'medium', confidence: 0.7, createdAt: 1 },
    ];
    writeSuggestions({ projectRoot: tmp, actions });
    const content = readFileSync(join(tmp, '.codekeeper', 'suggestions.md'), 'utf-8');
    expect(content).toContain('## 批量操作');
    expect(content).toContain('codekeeper-advance process --api-key');
  });
});
