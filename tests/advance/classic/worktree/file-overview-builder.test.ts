import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileOverview } from '../../../../src/advance/classic/worktree/file-overview-builder.js';

describe('FileOverviewBuilder', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'overview-test-'));
    tempFile = join(tempDir, 'sample.ts');
  });

  afterEach(() => {
    try {
      unlinkSync(tempFile);
    } catch {
      // 忽略
    }
  });

  it('识别 TS 函数、类、接口', async () => {
    writeFileSync(
      tempFile,
      `import { foo } from './foo';\n\nexport interface Config {\n  name: string;\n}\n\nclass Worker {\n  run() {}\n}\n\nexport async function handler() {\n  return 1;\n}\n`,
      'utf-8'
    );

    const overview = await buildFileOverview(tempFile);
    expect(overview.lineCount).toBe(13);
    expect(overview.symbols.map((s) => s.name)).toContain('Config');
    expect(overview.symbols.map((s) => s.name)).toContain('Worker');
    expect(overview.symbols.map((s) => s.name)).toContain('handler');
  });

  it('大文件只扫描指定行数', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `// line ${i + 1}`);
    lines[2500] = 'function bigFn() {}';
    writeFileSync(tempFile, lines.join('\n') + '\n', 'utf-8');

    const overview = await buildFileOverview(tempFile, { maxScanLines: 2000 });
    expect(overview.lineCount).toBe(5000);
    expect(overview.symbols.map((s) => s.name)).not.toContain('bigFn');
  });
});
