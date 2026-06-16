import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReadme } from '../../../src/advance/codekeeper/readme-writer';

describe('writeReadme', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-readme-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应生成 README.md 说明文件', () => {
    writeReadme({ archiveRoot: join(tmp, '.codekeeper') });
    const content = readFileSync(join(tmp, '.codekeeper', 'README.md'), 'utf-8');
    expect(content).toContain('# CodeKeeper 归档目录说明');
    expect(content).toContain('| context.md |');
    expect(content).toContain('| suggestions.md |');
    expect(content).toContain('| status.json |');
    expect(content).toContain('消费指南');
  });
});
