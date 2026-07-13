import { describe, it, expect } from 'vitest';
import { SetupCommandSafetyFilter } from '../../../../src/advance/classic/fix/tools/setup-command-safety-filter.js';

describe('SetupCommandSafetyFilter', () => {
  it('允许 npm install', () => {
    const result = new SetupCommandSafetyFilter().check('npm install');
    expect(result.allowed).toBe(true);
  });

  it('拦截 rm 命令', () => {
    const result = new SetupCommandSafetyFilter().check('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('危险');
  });

  it('允许 cargo build', () => {
    expect(new SetupCommandSafetyFilter().check('cargo build').allowed).toBe(true);
  });

  it('允许 poetry install', () => {
    expect(new SetupCommandSafetyFilter().check('poetry install').allowed).toBe(true);
  });

  it('拦截管道命令', () => {
    expect(new SetupCommandSafetyFilter().check('npm install | rm -rf /').allowed).toBe(false);
  });

  it('拦截路径逃逸', () => {
    expect(new SetupCommandSafetyFilter().check('npm install ../../').allowed).toBe(false);
  });
});
