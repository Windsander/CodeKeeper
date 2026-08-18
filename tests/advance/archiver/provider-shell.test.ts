import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderShell } from '../../../src/advance/archiver/provider-shell.js';

describe('ProviderShell', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'provider-shell-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('将元字符作为单个 argv 传递而不经 shell 解释', async () => {
    const shell = new ProviderShell();
    const argument = 'alpha && beta | gamma > delta';
    const result = await shell.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]))', argument],
      cwd: workspace,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(JSON.parse(result.stdout)).toBe(argument);
  });

  it('从 PATH 解析可执行文件', () => {
    const shell = new ProviderShell({
      env: {
        PATH: dirname(process.execPath),
        PATHEXT: process.env.PATHEXT,
      },
    });

    const resolved = shell.resolveExecutable(basename(process.execPath));

    expect(resolved).not.toBeNull();
    expect(basename(resolved ?? '').toLowerCase()).toBe(basename(process.execPath).toLowerCase());
  });

  it('默认隔离环境并仅继承 Adapter 显式声明的变量', async () => {
    const shell = new ProviderShell({
      env: {
        PATH: dirname(process.execPath),
        PATHEXT: process.env.PATHEXT,
        SAFE_PROVIDER_SETTING: 'enabled',
        PRIVATE_PROVIDER_TOKEN: 'secret',
      },
    });
    const result = await shell.run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      cwd: workspace,
      inheritEnv: ['SAFE_PROVIDER_SETTING'],
      env: { PROVIDER_MODE: 'test' },
    });

    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(result.success).toBe(true);
    expect(childEnv.SAFE_PROVIDER_SETTING).toBe('enabled');
    expect(childEnv.PROVIDER_MODE).toBe('test');
    expect(childEnv.PRIVATE_PROVIDER_TOKEN).toBeUndefined();
  });

  it('无权读取或不存在的工作目录返回结构化失败', async () => {
    const result = await new ProviderShell().run({
      executable: process.execPath,
      cwd: join(workspace, 'missing-directory'),
    });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('spawn-error');
    expect(result.error).toContain('工作目录');
  });

  it('拒绝无效的继承环境变量名', async () => {
    const result = await new ProviderShell().run({
      executable: process.execPath,
      cwd: workspace,
      inheritEnv: ['INVALID KEY'],
    });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('spawn-error');
    expect(result.error).toContain('继承环境变量名无效');
  });

  it('限制标准输出并保留尾部内容', async () => {
    const shell = new ProviderShell();
    const result = await shell.run({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('A'.repeat(32) + 'B'.repeat(32))"],
      cwd: workspace,
      maxOutputBytes: 16,
    });

    expect(result.success).toBe(true);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toBe('B'.repeat(16));
  });

  it('支持 Provider 自定义成功退出码', async () => {
    const result = await new ProviderShell().run({
      executable: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: workspace,
      acceptedExitCodes: [0, 3],
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(3);
  });

  it('拒绝无效的超时与输出上限', async () => {
    const shell = new ProviderShell();
    const invalidTimeout = await shell.run({
      executable: process.execPath,
      cwd: workspace,
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    const invalidOutputLimit = await shell.run({
      executable: process.execPath,
      cwd: workspace,
      maxOutputBytes: 0,
    });

    expect(invalidTimeout.failureKind).toBe('spawn-error');
    expect(invalidTimeout.error).toContain('超时');
    expect(invalidOutputLimit.failureKind).toBe('spawn-error');
    expect(invalidOutputLimit.error).toContain('输出上限');
  });

  it('在超时后终止 Provider 进程', async () => {
    const shell = new ProviderShell();
    const result = await shell.run({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: workspace,
      timeoutMs: 100,
    });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('timeout');
  }, 10_000);

  it('响应 AbortSignal 并终止 Provider 进程', async () => {
    const shell = new ProviderShell();
    const controller = new AbortController();
    const pending = shell.run({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: workspace,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('aborted');
  }, 10_000);

  it.runIf(process.platform === 'win32')('安全执行 Windows cmd shim', async () => {
    const executionRoot = join(workspace, 'provider workspace');
    const shimRoot = join(executionRoot, 'node_modules', '.bin');
    mkdirSync(shimRoot, { recursive: true });
    const scriptPath = join(shimRoot, 'echo-argv.js');
    const shimPath = join(shimRoot, 'echo-argv.cmd');
    const unexpectedPath = join(executionRoot, 'unexpected.txt');
    writeFileSync(
      scriptPath,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
      'utf8'
    );
    writeFileSync(
      shimPath,
      '@ECHO off\r\n"' + process.execPath + '" "' + scriptPath + '" %*\r\n',
      'utf8'
    );
    const payload = 'alpha & echo injected > unexpected.txt';
    const shell = new ProviderShell();

    const result = await shell.run({
      executable: shimPath,
      args: [payload],
      cwd: executionRoot,
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual([payload]);
    expect(existsSync(unexpectedPath)).toBe(false);
  });
});
