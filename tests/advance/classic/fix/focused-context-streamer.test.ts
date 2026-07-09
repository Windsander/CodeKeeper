import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFocusedContextStreamed,
  fileWindowResultToFocusedContext,
  focusedContextToString,
} from '../../../../src/advance/classic/fix/focused-context-streamer.js';

describe('focused-context-streamer', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'focused-streamer-test-'));
    tempFile = join(tempDir, 'sample.ts');
  });

  afterEach(() => {
    try {
      unlinkSync(tempFile);
    } catch {
      // 忽略
    }
  });

  it('buildFocusedContextStreamed 返回正确的 FocusedContext', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
    lines.unshift("import { foo } from './foo';");
    writeFileSync(tempFile, lines.join('\n') + '\n', 'utf-8');

    const focused = await buildFocusedContextStreamed(tempFile, {
      file: 'sample.ts',
      line: 50,
      severity: 'MEDIUM',
      message: 'test',
      suggestion: '',
    });

    expect(focused.totalLines).toBe(101);
    expect(focused.targetLine).toBe(50);
    expect(focused.imports).toContain("import { foo } from './foo';");
    expect(focused.snippet).toContain('line-50');
    expect(focused.truncated).toBe(true);
  });

  it('fileWindowResultToFocusedContext 保持行号信息', () => {
    const focused = fileWindowResultToFocusedContext(
      {
        content: 'a\nb',
        startLine: 10,
        endLine: 11,
        totalLines: 100,
        isPartial: true,
        imports: "import { x } from './x';",
      },
      { file: 'x.ts', line: 10, severity: 'MEDIUM', message: '', suggestion: '' }
    );
    expect(focused.snippetStartLine).toBe(10);
    expect(focused.snippetEndLine).toBe(11);
  });

  it('focusedContextToString 拼接 imports 和 snippet', () => {
    const str = focusedContextToString({
      imports: "import { x } from './x';",
      snippet: 'const a = 1;',
      snippetStartLine: 1,
      snippetEndLine: 1,
      totalLines: 1,
      truncated: false,
      targetLine: 1,
    });
    expect(str).toContain("import { x } from './x';");
    expect(str).toContain('const a = 1;');
  });
});
