import { describe, expect, it } from 'vitest';
import { buildArchiverSourceFingerprint } from '../../../../src/advance/classic/runners/archiver-runner.js';

describe('buildArchiverSourceFingerprint', () => {
  it('文件列表顺序变化时保持稳定', () => {
    const contents = {
      'virtual/module-a.ts': 'export const moduleA = true;',
      'virtual/module-b.ts': 'export const moduleB = true;',
    };

    const first = buildArchiverSourceFingerprint(
      ['virtual/module-a.ts', 'virtual/module-b.ts'],
      contents
    );
    const second = buildArchiverSourceFingerprint(
      ['virtual/module-b.ts', 'virtual/module-a.ts'],
      contents
    );

    expect(second).toBe(first);
  });

  it('文件名不变但内容变化时生成新指纹', () => {
    const sourceFiles = ['virtual/module-a.ts'];
    const first = buildArchiverSourceFingerprint(sourceFiles, {
      'virtual/module-a.ts': 'export const version = 1;',
    });
    const second = buildArchiverSourceFingerprint(sourceFiles, {
      'virtual/module-a.ts': 'export const version = 2;',
    });

    expect(second).not.toBe(first);
  });
});
