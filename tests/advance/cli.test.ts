import { describe, it, expect } from 'vitest';
import { parseFlag, extractRootPath } from '../../src/advance/cli';

describe('CLI 参数解析', () => {
  it('parseFlag 应返回 flag 后的值', () => {
    expect(parseFlag(['--api-key', 'abc', '/path'], '--api-key')).toBe('abc');
  });

  it('parseFlag 在 flag 缺失时返回 undefined', () => {
    expect(parseFlag(['/path'], '--api-key')).toBeUndefined();
  });

  it('parseFlag 在 flag 位于末尾时返回 undefined', () => {
    expect(parseFlag(['/path', '--api-key'], '--api-key')).toBeUndefined();
  });

  it('extractRootPath 应跳过 flag 及其值', () => {
    expect(extractRootPath(['--api-key', 'abc', '/path'], ['--api-key'])).toBe('/path');
  });

  it('extractRootPath 在只有 flag 时返回 undefined', () => {
    expect(extractRootPath(['--api-key', 'abc'], ['--api-key'])).toBeUndefined();
  });

  it('extractRootPath 支持多个 flag', () => {
    expect(
      extractRootPath(['--foo', '1', '--bar', '2', '/path'], ['--foo', '--bar']),
    ).toBe('/path');
  });
});
