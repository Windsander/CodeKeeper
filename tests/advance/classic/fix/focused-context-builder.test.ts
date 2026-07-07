/**
 * focused-context-builder 单元测试
 */

import { describe, it, expect } from 'vitest';
import { buildFocusedContext } from '../../../../src/advance/classic/fix/focused-context-builder.js';
import type { ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function makeFinding(line: number, file = 'src/a.ts'): ReviewFinding {
  return {
    severity: 'MEDIUM',
    file,
    line,
    message: '问题',
    suggestion: '建议',
  };
}

describe('buildFocusedContext', () => {
  it('提取 imports 和目标行附近片段', () => {
    const content = `import { a } from './a';\nimport { b } from './b';\n\nexport function foo() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n\nexport function bar() {\n  return 42;\n}\n`;
    const ctx = buildFocusedContext(content, makeFinding(6), { padding: 2 });
    expect(ctx.imports).toBe("import { a } from './a';\nimport { b } from './b';");
    expect(ctx.snippet).toContain('const x = 1');
    expect(ctx.snippet).toContain('const y = 2');
    expect(ctx.snippet).not.toContain('return 42');
    expect(ctx.targetLine).toBe(6);
  });

  it('扩展到函数边界', () => {
    const content = `\nfunction top() {}\n\nfunction target() {\n  a();\n  b();\n  c();\n}\n\nfunction bottom() {}\n`;
    const ctx = buildFocusedContext(content, makeFinding(5), { padding: 2 });
    expect(ctx.snippet).toContain('function target');
    expect(ctx.snippet).toContain('a();');
    expect(ctx.snippet).toContain('c();');
    expect(ctx.snippet).not.toContain('function bottom');
  });

  it('目标行在文件开头时正确处理', () => {
    const content = `first\nsecond\nthird\n`;
    const ctx = buildFocusedContext(content, makeFinding(1));
    expect(ctx.snippet).toContain('first');
    expect(ctx.imports).toBe('');
  });

  it('maxLines 触发截断', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`line ${i}`);
    }
    const content = lines.join('\n') + '\n';
    const ctx = buildFocusedContext(content, makeFinding(50), { maxLines: 10 });
    expect(ctx.truncated).toBe(true);
    const snippetLines = ctx.snippet.split('\n').filter((l) => l !== '');
    expect(snippetLines.length).toBeLessThanOrEqual(10);
  });

  it('padding 参数生效', () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const ctx = buildFocusedContext(content, makeFinding(30), { padding: 3, expandToBoundary: false });
    expect(ctx.snippetStartLine).toBe(27);
    expect(ctx.snippetEndLine).toBe(33);
  });

  it('保留 shebang 和顶部注释', () => {
    const content = `#!/usr/bin/env node\n// top comment\nimport { x } from 'x';\n\nconst a = 1;\n`;
    const ctx = buildFocusedContext(content, makeFinding(5));
    expect(ctx.imports).toContain('#!/usr/bin/env node');
    expect(ctx.imports).toContain('// top comment');
    expect(ctx.imports).toContain("import { x } from 'x';");
  });
});
