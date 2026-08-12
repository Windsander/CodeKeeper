import { describe, expect, it } from 'vitest';
import {
  compactDiscussionReason,
  stripTerminalControlCodes,
} from '../../../../../src/advance/classic/runners/shared/reply-safety.js';

describe('reply safety', () => {
  it('压缩长日志时保留中部真正的 TypeScript 诊断', () => {
    const reason = [
      'Worktree compile:packages 失败: Command failed',
      'npm error code 2',
      ...Array.from({ length: 30 }, (_, index) => `构建步骤 ${index} 已完成`),
      'src/module.ts(12,15): error TS2305: Module has no exported member.',
      ...Array.from({ length: 20 }, (_, index) => `后续构建步骤 ${index}`),
      'npm error command failed',
    ].join('\n');

    const compacted = compactDiscussionReason(reason);

    expect(compacted).toContain('error TS2305');
    expect(compacted).toContain('已省略');
    expect(compacted).not.toContain('构建步骤 15 已完成');
  });

  it('移除终端控制字符', () => {
    expect(stripTerminalControlCodes('\u001b[31m失败\u001b[0m\0')).toBe('失败');
  });
});
