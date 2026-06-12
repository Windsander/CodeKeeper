import { mkdtempSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { loadProjectConfig } from '../../../src/advance/config/project-config';

describe('loadProjectConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmdirSync(dir, { recursive: true });
      } catch {
        // 忽略清理失败
      }
    }
    tempDirs.length = 0;
  });

  it('当 .codekeeper/config.yaml 不存在时返回默认配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
    tempDirs.push(dir);
    const config = loadProjectConfig(dir);
    expect(config.include).toContain('**/*.md');
    expect(config.exclude).toContain('node_modules/**');
    expect(config.categories).toEqual([]);
    expect(config.name).toBeUndefined();
  });

  it('能正确解析存在的配置文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.codekeeper'));
    writeFileSync(
      join(dir, '.codekeeper', 'config.yaml'),
      'name: demo\ninclude:\n  - "**/*.ts"\nexclude:\n  - "dist/**"\n'
    );
    const config = loadProjectConfig(dir);
    expect(config.name).toBe('demo');
    expect(config.include).toEqual(['**/*.ts']);
  });

  it('遇到非法配置时抛出错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.codekeeper'));
    writeFileSync(
      join(dir, '.codekeeper', 'config.yaml'),
      'include: "not-an-array"\n'
    );
    expect(() => loadProjectConfig(dir)).toThrow();
  });

  it('当 projectRoot 本身不存在时返回默认配置', () => {
    const nonExistentDir = join(tmpdir(), 'ck-test-nonexistent-' + Date.now());
    // 不创建目录，直接传入不存在的路径
    const config = loadProjectConfig(nonExistentDir);
    expect(config.include).toContain('**/*.md');
    expect(config.exclude).toContain('node_modules/**');
    expect(config.categories).toEqual([]);
  });
});
