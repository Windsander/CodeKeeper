/**
 * soul-loader 单元测试
 *
 * SOUL.md 现在存放在 CodeKeeper App 存储空间：
 * ~/.codekeeper/memory/souls/{projectName}/{role}-SOUL.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSoulContent,
  saveSoulContent,
  getSoulFileName,
  getSoulPath,
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

describe('getSoulFileName', () => {
  it('reviewer Soul 文件名为 MR-REVIEWER-SOUL.md', () => {
    expect(getSoulFileName('reviewer')).toBe('MR-REVIEWER-SOUL.md');
  });

  it('maintainer Soul 文件名为 MAINTAINER-SOUL.md', () => {
    expect(getSoulFileName('maintainer')).toBe('MAINTAINER-SOUL.md');
  });

  it('未知角色应抛出错误', () => {
    // @ts-expect-error 故意传入未支持的角色
    expect(() => getSoulFileName('unknown')).toThrow('未支持的角色');
  });
});

describe('getSoulPath', () => {
  it('应返回正确的完整路径', () => {
    const project = makeProject('test-path');
    const soulsDir = getProjectSoulsDir('test-path');
    expect(getSoulPath(project, 'reviewer')).toBe(
      join(soulsDir, 'MR-REVIEWER-SOUL.md'),
    );
    expect(getSoulPath(project, 'maintainer')).toBe(
      join(soulsDir, 'MAINTAINER-SOUL.md'),
    );
  });
});

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

  it('reviewer 保存后读取应一致', async () => {
    const content = '# 测试 SOUL\n## 评审风格\n严格但友善';
    await saveSoulContent(project, 'reviewer', content);

    const sourcePath = join(soulsDir, 'MR-REVIEWER-SOUL.md');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(content);

    const loaded = loadSoulContent(project, 'reviewer');
    expect(loaded.content).toBe(content);
    expect(loaded.sourcePath).toBe(sourcePath);
  });

  it('maintainer 保存后读取应一致', async () => {
    const content = '# 维护者 SOUL\n## 维护风格\n严谨细致';
    await saveSoulContent(project, 'maintainer', content);

    const sourcePath = join(soulsDir, 'MAINTAINER-SOUL.md');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(content);

    const loaded = loadSoulContent(project, 'maintainer');
    expect(loaded.content).toBe(content);
    expect(loaded.sourcePath).toBe(sourcePath);
  });

  it('不同角色 SOUL 文件应独立存储', async () => {
    const reviewerContent = '# Reviewer SOUL';
    const maintainerContent = '# Maintainer SOUL';

    await saveSoulContent(project, 'reviewer', reviewerContent);
    await saveSoulContent(project, 'maintainer', maintainerContent);

    const loadedReviewer = loadSoulContent(project, 'reviewer');
    const loadedMaintainer = loadSoulContent(project, 'maintainer');

    expect(loadedReviewer.content).toBe(reviewerContent);
    expect(loadedMaintainer.content).toBe(maintainerContent);
    expect(loadedReviewer.sourcePath).toBe(join(soulsDir, 'MR-REVIEWER-SOUL.md'));
    expect(loadedMaintainer.sourcePath).toBe(join(soulsDir, 'MAINTAINER-SOUL.md'));
  });

  it('SOUL.md 不存在时返回默认路径和空内容', () => {
    const result = loadSoulContent(project, 'reviewer');
    expect(result.content).toBe('');
    expect(result.sourcePath).toBe(join(soulsDir, 'MR-REVIEWER-SOUL.md'));
  });

  it('文件名非法字符会被替换为下划线', async () => {
    const weirdName = 'project/name:with|special';
    const weirdProject = makeProject(weirdName);
    await saveSoulContent(weirdProject, 'reviewer', 'test');
    const path = join(
      getProjectSoulsDir('project_name_with_special'),
      'MR-REVIEWER-SOUL.md',
    );
    expect(existsSync(path)).toBe(true);
    rmSync(getProjectSoulsDir('project_name_with_special'), {
      recursive: true,
      force: true,
    });
  });
});
