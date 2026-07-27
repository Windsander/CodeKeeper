import { describe, expect, it } from 'vitest';
import {
  getFindingKey,
  normalizeAndDedupeFindings,
  normalizeFindingFilePath,
  reconcileFindingDecisionAliases,
} from '../../../../../src/advance/classic/runners/shared/finding-identity.js';
import type { MaintainerFindingDecision } from '../../../../../src/advance/classic/runners/shared/state-utils.js';

const changedFiles = ['modules/example-a/src/tracker.test.ts', 'modules/example-b/src/worker.ts'];

describe('finding identity', () => {
  it('将绝对路径、相对路径和唯一文件名映射为同一仓库路径', () => {
    const options = { projectRootPath: '/virtual/workspace/sample-repo', changedFiles };
    const canonical = 'modules/example-a/src/tracker.test.ts';

    expect(normalizeFindingFilePath(`/ci/builds/group/sample-repo/${canonical}`, options)).toBe(
      canonical
    );
    expect(normalizeFindingFilePath(canonical, options)).toBe(canonical);
    expect(normalizeFindingFilePath('tracker.test.ts', options)).toBe(canonical);
  });

  it('文件名不唯一时不猜测仓库路径', () => {
    expect(
      normalizeFindingFilePath('index.ts', {
        changedFiles: ['modules/example-a/src/index.ts', 'modules/example-b/src/index.ts'],
      })
    ).toBe('index.ts');
  });

  it('规范化后按稳定 file:line 去重', () => {
    const findings = normalizeAndDedupeFindings(
      [
        {
          severity: 'LOW',
          file: '/ci/builds/group/sample-repo/modules/example-a/src/tracker.test.ts',
          line: 20,
          message: '问题一',
          suggestion: '修复',
        },
        {
          severity: 'LOW',
          file: 'tracker.test.ts',
          line: 20,
          message: '重复问题',
          suggestion: '修复',
        },
      ],
      { changedFiles }
    );

    expect(findings).toHaveLength(1);
    expect(getFindingKey(findings[0])).toBe('modules/example-a/src/tracker.test.ts:20');
  });

  it('合并当前 finding 的历史路径别名并优先保留终态决策', () => {
    const failed: MaintainerFindingDecision = {
      action: 'fix',
      reason: '历史修复失败',
      failedAttempts: 1,
      decidedAt: 20,
    };
    const completed: MaintainerFindingDecision = {
      action: 'ignore',
      alreadyFixed: true,
      reason: '当前代码已修复',
      failedAttempts: 0,
      decidedAt: 10,
    };
    const decisions = {
      '/ci/builds/group/sample-repo/modules/example-a/src/tracker.test.ts:20': failed,
      'modules/example-a/src/tracker.test.ts:20': completed,
      'modules/example-b/src/worker.ts:8': failed,
    };

    const merged = reconcileFindingDecisionAliases(
      decisions,
      ['modules/example-a/src/tracker.test.ts:20'],
      { changedFiles }
    );

    expect(merged).toBe(1);
    expect(decisions['modules/example-a/src/tracker.test.ts:20']).toBe(completed);
    expect(decisions).not.toHaveProperty(
      '/ci/builds/group/sample-repo/modules/example-a/src/tracker.test.ts:20'
    );
    expect(decisions).toHaveProperty('modules/example-b/src/worker.ts:8');
  });
});
