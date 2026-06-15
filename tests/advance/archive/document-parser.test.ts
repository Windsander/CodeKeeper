import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from '../../../src/advance/archive/document-parser';

describe('parseDocument', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应读取 markdown 文件并计算 sha256 哈希', () => {
    const path = join(tmp, 'note.md');
    writeFileSync(path, '# 测试\n内容', 'utf-8');
    const doc = parseDocument(path);
    expect(doc.filePath).toBe(path);
    expect(doc.content).toBe('# 测试\n内容');
    expect(doc.contentHash).toHaveLength(16);
    expect(doc.size).toBe(15); // '# 测试\n内容' 的 utf-8 字节长度
    expect(doc.modifiedAt).toBeGreaterThan(0);
    expect(Number.isFinite(doc.modifiedAt)).toBe(true);
    const doc2 = parseDocument(path);
    expect(doc2.contentHash).toBe(doc.contentHash);
  });

  it('超过最大长度应截断并标记', () => {
    const path = join(tmp, 'long.md');
    writeFileSync(path, 'a'.repeat(20000), 'utf-8');
    const doc = parseDocument(path, { maxLength: 5000 });
    expect(doc.content).toBe('a'.repeat(5000));
    expect(doc.content.length).toBeLessThanOrEqual(5000);
    expect(doc.truncated).toBe(true);
  });

  it('不存在文件应抛出异常', () => {
    expect(() => parseDocument(join(tmp, 'missing.md'))).toThrow(/ENOENT/);
  });
});
