import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSoulContent } from '../../../../src/advance/classic/soul/soul-loader.js';

describe('loadSoulContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'soul-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('优先返回项目根目录 MR-Agent-SOUL.md', () => {
    const rootSoul = join(tmpDir, 'MR-Agent-SOUL.md');
    const archiveDir = join(tmpDir, '.codekeeper');
    const archiveSoul = join(archiveDir, 'MR-Agent-SOUL.md');
    writeFileSync(rootSoul, '根目录 SOUL', 'utf-8');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(archiveSoul, '归档目录 SOUL', 'utf-8');

    const result = loadSoulContent(tmpDir, archiveDir);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('根目录 SOUL');
    expect(result?.sourcePath).toBe(rootSoul);
  });

  it('项目根目录不存在时回退到归档目录', () => {
    const archiveDir = join(tmpDir, '.codekeeper');
    const archiveSoul = join(archiveDir, 'MR-Agent-SOUL.md');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(archiveSoul, '归档目录 SOUL', 'utf-8');

    const result = loadSoulContent(tmpDir, archiveDir);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('归档目录 SOUL');
  });

  it('都不存在时返回 null', () => {
    const result = loadSoulContent(tmpDir);
    expect(result).toBeNull();
  });
});
