/**
 * soul-loader 单元测试
 *
 * SOUL.md 现在存放在 CodeKeeper App 存储空间：
 * ~/.codekeeper/memory/souls/{projectName}/MR-Agent-SOUL.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSoulContent,
  saveSoulContent,
} from '../../../../src/advance/classic/soul/soul-loader.js';
import { getProjectSoulsDir } from '../../../../src/core/platform.js';
import type { Project } from '../../../../src/advance/types.js';

function makeProject(name: string): Project {
  return {
    id: `test-${name}`,
    name,
    rootPath: join(tmpdir(), `soul-project-${name}`),
    registeredAt: Date.now(),
    lastScannedAt: null,
  };
}

describe('soul-loader', () => {
  const projectName = `ck-soul-test-${Date.now()}`;
  const project = makeProject(projectName);
  const soulsDir = getProjectSoulsDir(projectName);

  beforeEach(() => {
    // 确保测试前目录干净
    if (existsSync(soulsDir)) {
      rmSync(soulsDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    rmSync(soulsDir, { recursive: true, force: true });
  });

  it('保存后读取应一致', () => {
    const content = '# 测试 SOUL\n## 评审风格\n严格但友善';
    const sourcePath = saveSoulContent(project, content);

    expect(sourcePath).toBe(join(soulsDir, 'MR-Agent-SOUL.md'));
    expect(readFileSync(sourcePath, 'utf-8')).toBe(content);

    const loaded = loadSoulContent(project);
    expect(loaded.content).toBe(content);
    expect(loaded.sourcePath).toBe(sourcePath);
  });

  it('SOUL.md 不存在时返回默认路径和空内容', () => {
    const result = loadSoulContent(project);
    expect(result.content).toBe('');
    expect(result.sourcePath).toBe(join(soulsDir, 'MR-Agent-SOUL.md'));
  });

  it('文件名非法字符会被替换为下划线', () => {
    const weirdName = 'project/name:with|special';
    const weirdProject = makeProject(weirdName);
    const path = saveSoulContent(weirdProject, 'test');
    expect(path).toContain('project_name_with_special');
    expect(path).not.toContain('project/name');
    rmSync(getProjectSoulsDir('project_name_with_special'), {
      recursive: true,
      force: true,
    });
  });
});
