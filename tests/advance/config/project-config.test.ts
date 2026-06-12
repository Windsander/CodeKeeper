import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadProjectConfig } from '../../../src/advance/config/project-config';

describe('loadProjectConfig', () => {
  it('当 .codekeeper/config.yaml 不存在时返回默认配置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
    const config = loadProjectConfig(dir);
    expect(config.include).toContain('**/*.md');
    expect(config.exclude).toContain('node_modules/**');
  });

  it('能正确解析存在的配置文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
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
    mkdirSync(join(dir, '.codekeeper'));
    writeFileSync(
      join(dir, '.codekeeper', 'config.yaml'),
      'include: "not-an-array"\n'
    );
    expect(() => loadProjectConfig(dir)).toThrow();
  });
});
