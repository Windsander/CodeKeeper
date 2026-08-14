import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EVEROS_FCNTL_SHIM_FILE,
  getFcntlShimContent,
  ensureFcntlShim,
  buildWindowsPythonPath,
  buildEverOSProcessEnv,
} from '../../../../src/advance/classic/memory/everos-windows-shim.js';

describe('everos-windows-shim', () => {
  it('shim 内容包含必要的 fcntl 符号与 portalocker 转发', () => {
    const content = getFcntlShimContent();
    expect(content).toContain('import portalocker');
    expect(content).toContain('LOCK_EX = 2');
    expect(content).toContain('LOCK_NB = 4');
    expect(content).toContain('LOCK_UN = 8');
    expect(content).toContain('def flock(fd: int, operation: int)');
    expect(content).toContain('portalocker.lock(file_obj, flags)');
  });

  it('ensureFcntlShim 将 shim 写入目标目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'everos-shim-'));
    try {
      const shimPath = await ensureFcntlShim(dir);
      expect(shimPath).toBe(join(dir, EVEROS_FCNTL_SHIM_FILE));
      const written = await readFile(shimPath, 'utf-8');
      expect(written).toBe(getFcntlShimContent());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('buildWindowsPythonPath 将 shim 目录置于最前', () => {
    expect(buildWindowsPythonPath('virtual-shim', 'virtual-existing')).toBe(
      'virtual-shim;virtual-existing'
    );
    expect(buildWindowsPythonPath('virtual-shim', undefined)).toBe('virtual-shim');
    expect(buildWindowsPythonPath('virtual-shim', '')).toBe('virtual-shim');
  });

  it('buildEverOSProcessEnv 只在 Windows 下注入 PYTHONPATH', () => {
    const env = { SOME_VAR: 'value' };
    expect(buildEverOSProcessEnv('linux', env, '/shim')).toBe(env);

    const winEnv = buildEverOSProcessEnv('win32', env, 'virtual-shim');
    expect(winEnv).not.toBe(env);
    expect(winEnv.PYTHONPATH).toBe('virtual-shim');
    expect(winEnv.SOME_VAR).toBe('value');
  });

  it('buildEverOSProcessEnv 保留已有的 PYTHONPATH', () => {
    const env = { PYTHONPATH: 'virtual-existing' };
    const winEnv = buildEverOSProcessEnv('win32', env, 'virtual-shim');
    expect(winEnv.PYTHONPATH).toBe('virtual-shim;virtual-existing');
  });
});
