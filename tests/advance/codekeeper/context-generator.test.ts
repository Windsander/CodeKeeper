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
      { filePath: join(tmp, 'a.md'), category: 'memory', docType: 'spec', summary: 'A 设计', tags: ['a'] },
      { filePath: join(tmp, 'b.md'), category: 'sync', docType: 'weekly', summary: 'B 周报', tags: ['b'] },
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

  it('应生成目录并稳定排序', () => {
    const entries = [
      { filePath: join(tmp, 'z.md'), category: 'zeta', docType: 'note', summary: 'Z', tags: [] },
      { filePath: join(tmp, 'a.md'), category: 'alpha', docType: 'note', summary: 'A', tags: [] },
      { filePath: join(tmp, 'm.md'), category: 'alpha', docType: 'note', summary: 'M', tags: [] },
    ];
    generateContext({ projectRoot: tmp, projectName: '排序测试', entries });
    const content = readFileSync(join(tmp, '.codekeeper', 'context.md'), 'utf-8');
    const alphaIndex = content.indexOf('## alpha');
    const zetaIndex = content.indexOf('## zeta');
    expect(alphaIndex).toBeLessThan(zetaIndex);
    const aIndex = content.indexOf('[a.md]');
    const mIndex = content.indexOf('[m.md]');
    expect(aIndex).toBeLessThan(mIndex);
    expect(content).toContain('- [alpha](#alpha)');
    expect(content).toContain('- [zeta](#zeta)');
  });

  it('应使用相对路径的 Markdown 链接并标注状态', () => {
    const entries = [
      {
        filePath: join(tmp, 'docs', 'x.md'),
        category: 'memory',
        docType: 'spec',
        summary: 'X',
        tags: [],
        status: 'archived' as const,
        updatedAt: 1000,
      },
    ];
    generateContext({ projectRoot: tmp, projectName: '状态测试', entries });
    const content = readFileSync(join(tmp, '.codekeeper', 'context.md'), 'utf-8');
    expect(content).toContain('[docs/x.md](docs/x.md)');
    expect(content).toContain('(已归档)');
    expect(content).toContain('更新：1970-01-01T00:00:01.000Z');
  });
});
