import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateContext } from '../../../src/advance/codekeeper/context-generator';

describe('generateContext', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-ctx-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应生成 context.md', () => {
    const entries = [
      { filePath: '/a.md', category: 'memory', docType: 'spec', summary: 'A 设计', tags: ['a'] },
      { filePath: '/b.md', category: 'sync', docType: 'weekly', summary: 'B 周报', tags: ['b'] },
    ];
    generateContext({ projectRoot: tmp, projectName: '测试项目', entries });
    const content = readFileSync(join(tmp, '.codekeeper', 'context.md'), 'utf-8');
    expect(content).toContain('# 测试项目 知识上下文');
    expect(content).toContain('## memory');
    expect(content).toContain('  - 标签：a');
    expect(content).toContain('A 设计');
    expect(content).toContain('B 周报');
  });

  it('entries 为空时应显示提示', () => {
    generateContext({ projectRoot: tmp, projectName: '测试项目', entries: [] });
    const content = readFileSync(join(tmp, '.codekeeper', 'context.md'), 'utf-8');
    expect(content).toContain('# 测试项目 知识上下文');
    expect(content).toContain('当前暂无已归档知识条目。');
  });
});
