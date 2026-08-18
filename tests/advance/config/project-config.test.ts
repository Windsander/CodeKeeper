import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  loadProjectConfig,
  matchesProjectPathPatterns,
} from '../../../src/advance/config/project-config';

describe('loadProjectConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
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
    expect(config.exclude).toContain('**/node_modules/**');
    expect(config.exclude).toContain('**/release/*-unpacked/**');
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
    writeFileSync(join(dir, '.codekeeper', 'config.yaml'), 'include: "not-an-array"\n');
    expect(() => loadProjectConfig(dir)).toThrow();
  });

  it('当 projectRoot 本身不存在时返回默认配置', () => {
    const nonExistentDir = join(tmpdir(), 'ck-test-nonexistent-' + Date.now());
    // 不创建目录，直接传入不存在的路径
    const config = loadProjectConfig(nonExistentDir);
    expect(config.include).toContain('**/*.md');
    expect(config.exclude).toContain('**/node_modules/**');
    expect(config.categories).toEqual([]);
  });

  it('项目自定义排除项不能关闭系统依赖目录保护', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-test-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, '.codekeeper'));
    writeFileSync(join(dir, '.codekeeper', 'config.yaml'), 'exclude: []\n');

    const config = loadProjectConfig(dir);

    expect(config.exclude).toContain('**/node_modules/**');
    expect(config.exclude).toContain('**/.git/**');
  });

  it('排除匹配应覆盖嵌套目录本身及其内容', () => {
    const patterns = ['**/node_modules/**', '**/release/*-unpacked/**'];

    expect(matchesProjectPathPatterns('virtual-package/node_modules', patterns)).toBe(true);
    expect(
      matchesProjectPathPatterns(
        'virtual-release/release/win-unpacked/resources/node_modules/dependency/CHANGELOG.md',
        patterns
      )
    ).toBe(true);
    expect(
      matchesProjectPathPatterns(
        'virtual-release/release/win-unpacked/resources/README.md',
        patterns
      )
    ).toBe(true);
    expect(matchesProjectPathPatterns('virtual-project/docs/README.md', patterns)).toBe(false);
  });
});
