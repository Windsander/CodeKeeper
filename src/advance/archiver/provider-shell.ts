import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { posix, win32, type PlatformPath } from 'node:path';

export type ProviderShellFailureKind =
  | 'not-found'
  | 'spawn-error'
  | 'timeout'
  | 'aborted'
  | 'exit-code';

/** 结构化命令请求，禁止调用方拼接 shell 字符串 */
export interface ProviderShellRequest {
  executable: string;
  args?: readonly string[];
  cwd: string;
  /** 默认仅继承运行时必需环境；额外变量必须由 Adapter 显式声明 */
  inheritEnv?: readonly string[] | 'all';
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
}

/** 统一命令执行结果 */
export interface ProviderShellResult {
  success: boolean;
  executable?: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  failureKind?: ProviderShellFailureKind;
  error?: string;
}

/** Adapter 依赖的最小执行接口，方便测试和未来替换本机、容器或远程后端 */
export interface ProviderCommandRunner {
  run(request: ProviderShellRequest): Promise<ProviderShellResult>;
}

/** 仅本机执行后端需要的可执行文件解析能力，不暴露给 Provider Adapter */
export interface ProviderExecutableResolver {
  resolveExecutable(executable: string, env?: NodeJS.ProcessEnv, cwd?: string): string | null;
}

export interface ProviderShellOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
}

interface CappedBuffer {
  value: Buffer;
  truncated: boolean;
}

interface SpawnInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Provider 统一进程执行层。
 *
 * 所有命令都通过 executable + args 启动且 shell=false，避免不同 Provider
 * 自行处理引号、重定向和平台 shell，从根源上降低注入与转义差异。
 */
export class ProviderShell implements ProviderCommandRunner, ProviderExecutableResolver {
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly path: PlatformPath;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxOutputBytes: number;

  constructor(options: ProviderShellOptions = {}) {
    this.baseEnv = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.path = this.platform === 'win32' ? win32 : posix;
    this.defaultTimeoutMs = normalizePositiveInteger(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.defaultMaxOutputBytes = normalizePositiveInteger(
      options.defaultMaxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES
    );
  }

  /** 在显式路径或 PATH 中解析可执行文件，不经过 shell */
  resolveExecutable(
    executable: string,
    env: NodeJS.ProcessEnv = this.baseEnv,
    cwd: string = process.cwd()
  ): string | null {
    const requested = stripOuterQuotes(executable.trim());
    if (!requested) return null;

    if (this.path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) {
      return this.resolveExecutableCandidate(this.path.resolve(cwd, requested), env);
    }

    const pathDelimiter = this.platform === 'win32' ? ';' : ':';
    const pathEntries = (this.getEnvironmentValue(env, 'PATH') ?? '')
      .split(pathDelimiter)
      .map(entry => stripOuterQuotes(entry.trim()))
      .filter(Boolean);
    for (const entry of pathEntries) {
      const searchRoot = this.path.isAbsolute(entry) ? entry : this.path.resolve(cwd, entry);
      const resolved = this.resolveExecutableCandidate(this.path.join(searchRoot, requested), env);
      if (resolved) return resolved;
    }
    return null;
  }

  async run(request: ProviderShellRequest): Promise<ProviderShellResult> {
    const startedAt = Date.now();
    const args = Array.isArray(request?.args)
      ? request.args.filter((argument): argument is string => typeof argument === 'string')
      : [];
    const validationError = validateRequest(request);
    if (validationError) {
      return this.failureResult(startedAt, args, 'spawn-error', validationError);
    }

    if (!isUsableDirectory(request.cwd, this.path)) {
      return this.failureResult(
        startedAt,
        args,
        'spawn-error',
        'Provider 工作目录必须是存在的绝对目录'
      );
    }

    const env = this.buildEnv(request.env, request.inheritEnv);
    const executable = this.resolveExecutable(request.executable, env, request.cwd);
    if (!executable) {
      return this.failureResult(
        startedAt,
        args,
        'not-found',
        `找不到可执行文件: ${request.executable}`
      );
    }

    if (request.signal?.aborted) {
      return this.failureResult(
        startedAt,
        args,
        'aborted',
        'Provider 命令在启动前已取消',
        executable
      );
    }

    const timeoutMs = normalizePositiveInteger(request.timeoutMs, this.defaultTimeoutMs);
    const maxOutputBytes = normalizePositiveInteger(
      request.maxOutputBytes,
      this.defaultMaxOutputBytes
    );
    const acceptedExitCodes = new Set(request.acceptedExitCodes ?? [0]);
    const invocation = this.buildSpawnInvocation(executable, args, env);
    if (!invocation) {
      return this.failureResult(
        startedAt,
        args,
        'spawn-error',
        'Windows 脚本需要可用的 cmd.exe 启动器',
        executable
      );
    }

    return new Promise(resolveResult => {
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: request.cwd,
          env,
          shell: false,
          windowsHide: true,
          detached: this.platform !== 'win32',
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolveResult(this.failureResult(startedAt, args, 'spawn-error', message, executable));
        return;
      }

      let stdout: CappedBuffer = { value: Buffer.alloc(0), truncated: false };
      let stderr: CappedBuffer = { value: Buffer.alloc(0), truncated: false };
      let settled = false;
      let failureKind: ProviderShellFailureKind | undefined;
      let failureMessage: string | undefined;

      const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', abortHandler);

        const accepted = exitCode !== null && acceptedExitCodes.has(exitCode);
        const finalFailureKind = failureKind ?? (accepted ? undefined : 'exit-code');
        const finalError =
          failureMessage ??
          (finalFailureKind === 'exit-code'
            ? `Provider 命令退出码为 ${exitCode ?? 'null'}`
            : undefined);
        resolveResult({
          success: !finalFailureKind,
          executable,
          args,
          exitCode,
          signal,
          stdout: stdout.value.toString('utf8'),
          stderr: stderr.value.toString('utf8'),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Date.now() - startedAt,
          failureKind: finalFailureKind,
          error: finalError,
        });
      };

      const terminate = (kind: ProviderShellFailureKind, message: string) => {
        if (settled || failureKind) return;
        failureKind = kind;
        failureMessage = message;
        this.terminate(child);
      };

      const timeout = setTimeout(() => {
        terminate('timeout', `Provider 命令执行超时（${timeoutMs}ms）`);
      }, timeoutMs);
      const abortHandler = () => terminate('aborted', 'Provider 命令已取消');
      request.signal?.addEventListener('abort', abortHandler, { once: true });
      if (request.signal?.aborted) abortHandler();

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = appendCapped(stdout, chunk, maxOutputBytes);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = appendCapped(stderr, chunk, maxOutputBytes);
      });
      child.on('error', error => {
        failureKind = failureKind ?? 'spawn-error';
        failureMessage = failureMessage ?? error.message;
      });
      child.on('close', settle);

      child.stdin?.on('error', () => undefined);
      if (request.stdin !== undefined) {
        child.stdin?.end(request.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }

  private buildEnv(
    overrides?: Record<string, string | undefined>,
    inheritEnv?: readonly string[] | 'all'
  ): NodeJS.ProcessEnv {
    const env =
      inheritEnv === 'all'
        ? { ...this.baseEnv }
        : this.pickEnvironment([...RUNTIME_ENVIRONMENT_KEYS, ...(inheritEnv ?? [])]);
    for (const [key, value] of Object.entries(overrides ?? {})) {
      const targetKey =
        this.platform === 'win32'
          ? (Object.keys(env).find(candidate => candidate.toLowerCase() === key.toLowerCase()) ??
            key)
          : key;
      if (value === undefined) {
        delete env[targetKey];
      } else {
        env[targetKey] = value;
      }
    }
    return env;
  }

  private pickEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of keys) {
      const value = this.getEnvironmentValue(this.baseEnv, key);
      if (value === undefined) continue;
      const sourceKey =
        this.platform === 'win32'
          ? Object.keys(this.baseEnv).find(
              candidate => candidate.toLowerCase() === key.toLowerCase()
            )
          : key;
      env[sourceKey ?? key] = value;
    }
    return env;
  }

  private buildSpawnInvocation(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv
  ): SpawnInvocation | null {
    if (this.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
      return { command: executable, args };
    }

    const commandInterpreter = this.resolveExecutable(
      this.getEnvironmentValue(env, 'ComSpec') ?? 'cmd.exe',
      env
    );
    if (!commandInterpreter) return null;

    const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.(?:cmd|bat)$/i.test(executable);
    const commandLine = [
      escapeWindowsCommand(executable),
      ...args.map(arg => escapeWindowsArgument(arg, doubleEscape)),
    ].join(' ');
    return {
      command: commandInterpreter,
      args: ['/d', '/s', '/c', `${commandLine}`],
      windowsVerbatimArguments: true,
    };
  }

  private resolveExecutableCandidate(candidate: string, env: NodeJS.ProcessEnv): string | null {
    const candidates =
      this.platform === 'win32' && !this.path.extname(candidate)
        ? this.windowsExecutableCandidates(candidate, env)
        : [candidate];
    for (const path of candidates) {
      try {
        accessSync(path, this.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch {
        if (this.platform === 'win32') {
          try {
            if (lstatSync(path).isSymbolicLink()) return path;
          } catch {
            // Windows 应用执行别名可能拒绝 stat，继续检查其它候选。
          }
        }
        continue;
      }
    }
    return null;
  }

  private windowsExecutableCandidates(candidate: string, env: NodeJS.ProcessEnv): string[] {
    const pathExt = this.getEnvironmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD';
    return pathExt
      .split(';')
      .map(extension => extension.trim())
      .filter(Boolean)
      .map(extension => `${candidate}${extension}`);
  }

  private getEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
    if (this.platform !== 'win32') return env[key];
    const actualKey = Object.keys(env).find(
      candidate => candidate.toLowerCase() === key.toLowerCase()
    );
    return actualKey ? env[actualKey] : undefined;
  }

  private terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      this.signalProcessTree(child, 'SIGKILL');
    }, 1000);
    forceTimer.unref();

    const pid = child.pid;
    if (this.platform === 'win32' && pid) {
      const taskkill = this.resolveExecutable('taskkill.exe');
      if (taskkill) {
        try {
          const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.once('error', () => this.signalProcessTree(child, 'SIGTERM'));
          killer.once('close', exitCode => {
            if (exitCode !== 0) this.signalProcessTree(child, 'SIGTERM');
          });
          killer.unref();
          return;
        } catch {
          // 终止器启动失败时继续使用直接信号。
        }
      }
    }

    this.signalProcessTree(child, 'SIGTERM');
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (this.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // 子进程可能在建立进程组前退出，继续尝试直接终止。
      }
    }
    try {
      child.kill(signal);
    } catch {
      // 子进程可能已在终止流程中退出。
    }
  }

  private failureResult(
    startedAt: number,
    args: string[],
    failureKind: ProviderShellFailureKind,
    error: string,
    executable?: string
  ): ProviderShellResult {
    return {
      success: false,
      executable,
      args,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      failureKind,
      error,
    };
  }
}

function validateRequest(request: ProviderShellRequest): string | null {
  if (!request || typeof request !== 'object') return 'Provider 命令请求无效';
  if (typeof request.executable !== 'string' || !request.executable.trim()) {
    return 'Provider 可执行文件不能为空';
  }
  if (request.executable.includes('\0')) return 'Provider 可执行文件包含非法空字符';
  if (typeof request.cwd !== 'string' || !request.cwd.trim()) return 'Provider 工作目录不能为空';
  if (request.cwd.includes('\0')) return 'Provider 工作目录包含非法空字符';
  if (
    request.args !== undefined &&
    (!Array.isArray(request.args) || request.args.some(argument => typeof argument !== 'string'))
  ) {
    return 'Provider 参数必须是字符串数组';
  }
  if (request.args?.some(argument => argument.includes('\0'))) {
    return 'Provider 参数包含非法空字符';
  }
  if (request.stdin !== undefined && typeof request.stdin !== 'string') {
    return 'Provider 标准输入必须是字符串';
  }
  if (request.stdin?.includes('\0')) return 'Provider 标准输入包含非法空字符';
  if (
    request.inheritEnv !== undefined &&
    request.inheritEnv !== 'all' &&
    (!Array.isArray(request.inheritEnv) || request.inheritEnv.some(key => typeof key !== 'string'))
  ) {
    return 'Provider 继承环境变量必须是字符串数组';
  }
  if (request.inheritEnv !== 'all') {
    for (const key of request.inheritEnv ?? []) {
      if (!isEnvironmentVariableName(key)) return `Provider 继承环境变量名无效: ${key}`;
    }
  }
  if (
    request.env !== undefined &&
    (!request.env || typeof request.env !== 'object' || Array.isArray(request.env))
  ) {
    return 'Provider 环境变量必须是对象';
  }
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!isEnvironmentVariableName(key)) return `Provider 环境变量名无效: ${key}`;
    if (value !== undefined && typeof value !== 'string')
      return `Provider 环境变量 ${key} 必须是字符串`;
    if (value?.includes('\0')) return `Provider 环境变量 ${key} 包含非法空字符`;
  }
  if (
    request.acceptedExitCodes !== undefined &&
    (!Array.isArray(request.acceptedExitCodes) ||
      request.acceptedExitCodes.some(code => typeof code !== 'number' || !Number.isInteger(code)))
  ) {
    return 'Provider 可接受退出码必须是整数数组';
  }
  if (
    request.timeoutMs !== undefined &&
    (typeof request.timeoutMs !== 'number' ||
      !Number.isFinite(request.timeoutMs) ||
      request.timeoutMs <= 0)
  ) {
    return 'Provider 超时必须是大于零的有限数值';
  }
  if (
    request.maxOutputBytes !== undefined &&
    (typeof request.maxOutputBytes !== 'number' ||
      !Number.isFinite(request.maxOutputBytes) ||
      request.maxOutputBytes <= 0)
  ) {
    return 'Provider 输出上限必须是大于零的有限数值';
  }
  return null;
}

function isUsableDirectory(path: string, pathApi: PlatformPath): boolean {
  if (!pathApi.isAbsolute(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 2_147_483_647)
    : fallback;
}

const RUNTIME_ENVIRONMENT_KEYS = [
  'PATH',
  'PATHEXT',
  'ComSpec',
  'SystemRoot',
  'WINDIR',
  'SystemDrive',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
] as const;

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function appendCapped(
  current: CappedBuffer,
  chunk: Buffer | string,
  maxBytes: number
): CappedBuffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const combined = Buffer.concat([current.value, incoming]);
  if (combined.byteLength <= maxBytes) {
    return { value: combined, truncated: current.truncated };
  }
  return {
    value: combined.subarray(combined.byteLength - maxBytes),
    truncated: true,
  };
}

const WINDOWS_META_CHARACTERS = /([()\][%!^"\x60<>&|;, *?])/g;

function escapeWindowsCommand(value: string): string {
  return value.replace(WINDOWS_META_CHARACTERS, '^$1');
}

function escapeWindowsArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`.replace(WINDOWS_META_CHARACTERS, '^$1');
  if (doubleEscapeMetaCharacters) {
    escaped = escaped.replace(WINDOWS_META_CHARACTERS, '^$1');
  }
  return escaped;
}
