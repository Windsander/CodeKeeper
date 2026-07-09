import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countLines,
  readImports,
  readRange,
  readWindow,
} from '../../../../src/advance/classic/worktree/streaming-file-reader.js';

describe('StreamingFileReader', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'streaming-test-'));
    tempFile = join(tempDir, 'sample.ts');
  });

  afterEach(() => {
    try {
      unlinkSync(tempFile);
    } catch {
      // 忽略清理失败
    }
  });

  it('countLines 正确统计行数', async () => {
    writeFileSync(tempFile, 'a\nb\nc\n', 'utf-8');
    expect(await countLines(tempFile)).toBe(3);
  });

  it('readImports 只返回顶部 import 区', async () => {
    writeFileSync(
      tempFile,
      "import { foo } from './foo';\n\nconst x = 1;\n",
      'utf-8'
    );
    const imports = await readImports(tempFile);
    expect(imports).toContain("import { foo } from './foo';");
    expect(imports).not.toContain('const x');
  });

  it('readWindow 返回目标行周围窗口和 import 区', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
    lines.unshift("import { foo } from './foo';");
    writeFileSync(tempFile, lines.join('\n') + '\n', 'utf-8');

    const result = await readWindow(tempFile, { targetLine: 50, padding: 5, maxLines: 80 });

    expect(result.totalLines).toBe(101);
    expect(result.startLine).toBeLessThanOrEqual(50);
    expect(result.endLine).toBeGreaterThanOrEqual(50);
    expect(result.content).toContain('line-50');
    expect(result.imports).toContain("import { foo } from './foo';");
    expect(result.isPartial).toBe(true);
  });

  it('readRange 返回精确行范围', async () => {
    writeFileSync(tempFile, 'a\nb\nc\nd\ne\n', 'utf-8');
    const result = await readRange(tempFile, 2, 4);
    expect(result.content).toBe('b\nc\nd');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(4);
  });

  it('大文件窗口读取不会加载完整内容', async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line-${i + 1}`);
    writeFileSync(tempFile, lines.join('\n') + '\n', 'utf-8');

    const result = await readWindow(tempFile, { targetLine: 5000, padding: 5, maxLines: 20 });

    expect(result.totalLines).toBe(10000);
    const returnedLines = result.content.split('\n').length;
    expect(returnedLines).toBeLessThanOrEqual(20);
  });
});
