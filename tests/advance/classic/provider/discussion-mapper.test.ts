import { describe, it, expect } from 'vitest';
import { buildDiffPosition, getFindingKey } from '../../../../src/advance/classic/provider/discussion-mapper.js';
import type { ReviewFinding, MrDiff } from '../../../../src/advance/classic/provider/types.js';

const shaInfo = {
  baseSha: 'base123',
  headSha: 'head456',
  startSha: 'start789',
};

const mockDiffs: MrDiff[] = [
  {
    filePath: 'src/index.ts',
    oldPath: 'src/index.ts',
    newPath: 'src/index.ts',
    newFile: false,
    deletedFile: false,
    diff: '@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n console.log(a);',
    additions: 1,
    deletions: 0,
  },
  {
    filePath: 'src/legacy.ts',
    oldPath: 'src/legacy.ts',
    newPath: 'src/legacy.ts',
    newFile: false,
    deletedFile: true,
    diff: '@@ -1,3 +0,0 @@\n-const old = 1;\n-console.log(old);',
    additions: 0,
    deletions: 2,
  },
];

describe('buildDiffPosition', () => {
  it('为普通文件变更构造 position', () => {
    const finding: ReviewFinding = {
      severity: 'HIGH',
      file: 'src/index.ts',
      line: 3,
      message: '问题',
      suggestion: '建议',
    };
    const pos = buildDiffPosition(finding, mockDiffs, shaInfo);
    expect(pos).not.toBeNull();
    expect(pos).toMatchObject({
      baseSha: 'base123',
      headSha: 'head456',
      startSha: 'start789',
      positionType: 'text',
      oldPath: 'src/index.ts',
      newPath: 'src/index.ts',
      newLine: 3,
    });
  });

  it('删除文件使用 old_line 定位', () => {
    const finding: ReviewFinding = {
      severity: 'HIGH',
      file: 'src/legacy.ts',
      line: 2,
      message: '问题',
      suggestion: '建议',
    };
    const pos = buildDiffPosition(finding, mockDiffs, shaInfo);
    expect(pos).not.toBeNull();
    expect(pos).toMatchObject({
      oldPath: 'src/legacy.ts',
      newPath: 'src/legacy.ts',
      newLine: 0,
      oldLine: 2,
    });
  });

  it('找不到对应 diff 时返回 null', () => {
    const finding: ReviewFinding = {
      severity: 'HIGH',
      file: 'src/notfound.ts',
      line: 1,
      message: '问题',
      suggestion: '建议',
    };
    const pos = buildDiffPosition(finding, mockDiffs, shaInfo);
    expect(pos).toBeNull();
  });

  it('非法行号返回 null', () => {
    const finding: ReviewFinding = {
      severity: 'HIGH',
      file: 'src/index.ts',
      line: -1,
      message: '问题',
      suggestion: '建议',
    };
    const pos = buildDiffPosition(finding, mockDiffs, shaInfo);
    expect(pos).toBeNull();
  });
});

describe('getFindingKey', () => {
  it('组合 file、line、ruleId 作为唯一键', () => {
    const finding: ReviewFinding = {
      severity: 'HIGH',
      file: 'src/index.ts',
      line: 3,
      ruleId: 'RULE-001',
      message: '问题',
      suggestion: '建议',
    };
    expect(getFindingKey(finding)).toBe('src/index.ts:3:RULE-001');
  });

  it('无 ruleId 时使用 generic', () => {
    const finding: ReviewFinding = {
      severity: 'LOW',
      file: 'src/utils.ts',
      line: 10,
      message: '问题',
      suggestion: '建议',
    };
    expect(getFindingKey(finding)).toBe('src/utils.ts:10:generic');
  });
});
