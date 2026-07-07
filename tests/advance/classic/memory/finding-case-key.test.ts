import { describe, it, expect } from 'vitest';
import { buildFindingCaseKey } from '../../../../src/advance/classic/memory/finding-case-key.js';

describe('buildFindingCaseKey', () => {
  it('生成标准 case key', () => {
    const key = buildFindingCaseKey({
      projectId: 'proj-1',
      mrIid: 1,
      file: 'src/a.ts',
      line: 10,
      ruleId: 'no-any',
    });
    expect(key).toBe('case:proj-1:mr-1:src_a.ts:10:no-any');
  });

  it('无 ruleId 时使用 generic', () => {
    const key = buildFindingCaseKey({
      projectId: 'proj-1',
      mrIid: 1,
      file: 'src/a.ts',
      line: 10,
    });
    expect(key).toBe('case:proj-1:mr-1:src_a.ts:10:generic');
  });

  it('清洗非法字符', () => {
    const key = buildFindingCaseKey({
      projectId: 'D:/project/path',
      mrIid: 1,
      file: 'src/a b.ts',
      line: 10,
      ruleId: 'rule@any',
    });
    expect(key).toBe('case:D__project_path:mr-1:src_a_b.ts:10:rule@any');
  });
});
