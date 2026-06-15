import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument, isTextFile } from '../../../src/advance/archive/document-parser';

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
    expect(doc.language).toBe('markdown');
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

  it('应识别多种代码文件的语言', () => {
    const cases = [
      { file: 'a.ts', lang: 'typescript' },
      { file: 'b.py', lang: 'python' },
      { file: 'c.json', lang: 'json' },
      { file: 'd.yaml', lang: 'yaml' },
      { file: 'e.sh', lang: 'shell' },
    ];
    for (const c of cases) {
      const path = join(tmp, c.file);
      writeFileSync(path, 'x', 'utf-8');
      const doc = parseDocument(path);
      expect(doc.language).toBe(c.lang);
    }
  });

  it('二进制文件应抛出 Unsupported 错误', () => {
    const path = join(tmp, 'image.png');
    // 写入包含 null 字节的伪二进制内容
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    expect(() => parseDocument(path)).toThrow(/不支持的文件类型/);
  });
});

describe('isTextFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应识别支持的文本扩展名', () => {
    expect(isTextFile(join(tmp, 'a.ts'))).toBe(true);
    expect(isTextFile(join(tmp, 'b.md'))).toBe(true);
  });

  it('应拒绝已知的二进制扩展名', () => {
    expect(isTextFile(join(tmp, 'a.png'))).toBe(false);
    expect(isTextFile(join(tmp, 'b.exe'))).toBe(false);
    expect(isTextFile(join(tmp, 'c.jpg'))).toBe(false);
  });

  it('无扩展名文件应通过内容检测判断', () => {
    const textPath = join(tmp, 'plain');
    const binPath = join(tmp, 'binary');
    writeFileSync(textPath, 'hello world', 'utf-8');
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02]));
    expect(isTextFile(textPath)).toBe(true);
    expect(isTextFile(binPath)).toBe(false);
  });
});
