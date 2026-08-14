import type {
  ArchiverProviderAdapter,
  ArchiverProviderDescriptor,
  ArchiverProviderLaunchPreset,
  ArchiverProviderManagedInvocation,
  ArchiverProviderOverride,
  ArchiverProviderPrepareResult,
  ArchiverProviderProbeResult,
  ArchiverProviderRuntime,
  ArchiverProviderSyncContext,
  ArchiverProviderSyncResult,
} from '../provider-types.js';
import type { ProviderShellRequest, ProviderShellResult } from '../provider-shell.js';

export interface ProviderInvocation {
  id?: string;
  displayName?: string;
  executable: string;
  argsPrefix: string[];
  env: Record<string, string>;
  inheritEnv: string[];
  managedVersion?: string;
}

export interface ProviderCommandSpec extends Omit<
  ProviderShellRequest,
  'executable' | 'args' | 'env' | 'inheritEnv' | 'timeoutMs'
> {
  args?: readonly string[];
  env?: Record<string, string | undefined>;
  inheritEnv?: readonly string[];
  /** Adapter 给出的默认超时，内部覆盖只能收紧或在上限内调整。 */
  timeoutMs?: number;
  /** 对内部超时覆盖设置上限，适合轻量探测命令。 */
  timeoutCapMs?: number;
}

interface ProviderInvocationSelection {
  invocation?: ProviderInvocation;
  result: ProviderShellResult;
  attempts: string[];
}

/** CLI Provider 基类，统一自动启动器探测、结构化命令和版本检查。 */
export abstract class CliProviderAdapter implements ArchiverProviderAdapter {
  abstract readonly descriptor: ArchiverProviderDescriptor;

  private readonly invocationCache = new Map<string, ProviderInvocation>();

  abstract sync(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult>;

  protected getVersionArgs(): string[] {
    return ['--version'];
  }

  async prepare(
    _context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderPrepareResult> {
    if (hasExplicitInvocationOverride(override)) {
      return {
        providerId: this.descriptor.id,
        success: false,
        prepared: false,
        message: '显式启动覆盖不参与系统自动准备',
      };
    }
    if (!runtime.provisioner || !this.descriptor.managedRuntime) {
      return {
        providerId: this.descriptor.id,
        success: false,
        prepared: false,
        message: 'Provider 未声明可自动准备的托管运行时',
      };
    }
    return runtime.provisioner.prepare(this.descriptor);
  }

  async probe(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderProbeResult> {
    const selection = await this.selectInvocation(context, runtime, override);
    if (!selection.invocation) {
      return {
        providerId: this.descriptor.id,
        available: false,
        readiness: this.descriptor.managedRuntime ? 'preparable' : 'unavailable',
        prepared: false,
        message:
          selection.attempts.length > 0
            ? `自动探测失败：${selection.attempts.join('；')}`
            : formatShellFailure(selection.result),
      };
    }

    const label = selection.invocation.displayName ?? selection.invocation.executable;
    return {
      providerId: this.descriptor.id,
      available: true,
      readiness: 'ready',
      prepared: Boolean(selection.invocation.managedVersion),
      executable: selection.result.executable ?? selection.invocation.executable,
      version:
        selection.invocation.managedVersion ??
        firstNonEmptyLine(selection.result.stdout, selection.result.stderr),
      message: selection.invocation.managedVersion
        ? `已自动选择托管运行时：${label}`
        : `已自动选择：${label}`,
    };
  }

  /** 使用已自动选择的启动器执行 Provider 语义命令。 */
  protected async runCommand(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override: ArchiverProviderOverride | undefined,
    command: ProviderCommandSpec
  ): Promise<ProviderShellResult> {
    const explicitInvocation = hasExplicitInvocationOverride(override);
    let invocation = explicitInvocation
      ? this.buildInvocation(override)
      : this.invocationCache.get(this.getInvocationCacheKey(context));
    if (!invocation) {
      const selection = await this.selectInvocation(context, runtime, override);
      invocation = selection.invocation;
      if (!invocation) return selection.result;
    }

    const result = await runtime.shell.run(this.buildCommandRequest(override, command, invocation));
    if (result.failureKind === 'not-found' && !explicitInvocation) {
      this.invocationCache.delete(this.getInvocationCacheKey(context));
    }
    return result;
  }

  /** 将 Provider 语义参数与已选启动方式合并为结构化命令请求。 */
  protected buildCommandRequest(
    override: ArchiverProviderOverride | undefined,
    command: ProviderCommandSpec,
    invocation: ProviderInvocation = this.buildInvocation(override)
  ): ProviderShellRequest {
    const {
      args = [],
      env,
      inheritEnv = [],
      timeoutMs: defaultTimeoutMs,
      timeoutCapMs,
      ...request
    } = command;
    const configuredTimeoutMs = override?.timeoutMs ?? defaultTimeoutMs;
    const timeoutMs =
      configuredTimeoutMs === undefined
        ? undefined
        : timeoutCapMs === undefined
          ? configuredTimeoutMs
          : Math.min(configuredTimeoutMs, timeoutCapMs);

    return {
      ...request,
      executable: invocation.executable,
      args: [...invocation.argsPrefix, ...args],
      inheritEnv: uniqueStrings([...invocation.inheritEnv, ...inheritEnv]),
      env: {
        ...env,
        ...invocation.env,
      },
      timeoutMs,
    };
  }

  protected buildInvocation(override?: ArchiverProviderOverride): ProviderInvocation {
    const requestedPreset = override?.launchPreset?.trim() || this.descriptor.defaultLaunchPreset;
    const preset = requestedPreset
      ? this.descriptor.launchPresets?.find(candidate => candidate.id === requestedPreset)
      : undefined;
    if (requestedPreset && !preset) {
      throw new Error(`Provider ${this.descriptor.id} 不支持启动预设 ${requestedPreset}`);
    }

    const executable =
      override?.executable?.trim() || preset?.executable || this.descriptor.defaultExecutable;
    if (!executable) {
      throw new Error(`Provider ${this.descriptor.id} 未声明可执行文件`);
    }
    return this.createInvocation(preset, override, executable);
  }

  private async selectInvocation(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ProviderInvocationSelection> {
    const managed =
      !hasExplicitInvocationOverride(override) && runtime.provisioner
        ? await runtime.provisioner.resolve(this.descriptor)
        : null;
    const candidates = this.buildInvocationCandidates(override, managed?.invocation);
    const attempts: string[] = [];
    let lastResult = unavailableShellResult([], `Provider ${this.descriptor.id} 未声明启动方式`);

    for (const invocation of candidates) {
      const result = await runtime.shell.run(
        this.buildCommandRequest(
          override,
          {
            args: this.getVersionArgs(),
            cwd: context.project.rootPath,
            timeoutMs: 15000,
            timeoutCapMs: 15000,
            maxOutputBytes: 16 * 1024,
          },
          invocation
        )
      );
      lastResult = result;
      const label = invocation.displayName ?? invocation.executable;
      if (result.success) {
        this.cacheInvocation(context, override, invocation);
        return { invocation, result, attempts };
      }

      attempts.push(`${label}: ${formatShellFailure(result)}`);
    }
    return { result: lastResult, attempts };
  }

  private buildInvocationCandidates(
    override?: ArchiverProviderOverride,
    managed?: ArchiverProviderManagedInvocation
  ): ProviderInvocation[] {
    if (hasExplicitInvocationOverride(override)) return [this.buildInvocation(override)];

    const candidates: ProviderInvocation[] = managed
      ? [
          {
            id: 'managed',
            displayName: '系统托管运行时',
            executable: managed.executable,
            argsPrefix: [...managed.argsPrefix],
            env: { ...(managed.env ?? {}) },
            inheritEnv: [...(managed.inheritEnv ?? [])],
            managedVersion: managed.version,
          },
        ]
      : [];
    candidates.push(
      ...(this.descriptor.launchPresets ?? []).map(preset =>
        this.createInvocation(preset, override, preset.executable)
      )
    );
    if (this.descriptor.defaultExecutable) {
      candidates.push({
        id: 'default',
        displayName: '默认命令',
        executable: this.descriptor.defaultExecutable,
        argsPrefix: [],
        env: { ...(override?.env ?? {}) },
        inheritEnv: [...(override?.inheritEnv ?? [])],
      });
    }
    return uniqueInvocations(candidates);
  }

  private createInvocation(
    preset: ArchiverProviderLaunchPreset | undefined,
    override: ArchiverProviderOverride | undefined,
    executable: string
  ): ProviderInvocation {
    return {
      id: preset?.id,
      displayName: preset?.displayName,
      executable,
      argsPrefix: [
        ...(override?.argsPrefix && override.argsPrefix.length > 0
          ? override.argsPrefix
          : (preset?.argsPrefix ?? [])),
      ],
      env: { ...(override?.env ?? {}) },
      inheritEnv: uniqueStrings([...(preset?.inheritEnv ?? []), ...(override?.inheritEnv ?? [])]),
    };
  }

  private cacheInvocation(
    context: ArchiverProviderSyncContext,
    override: ArchiverProviderOverride | undefined,
    invocation: ProviderInvocation
  ): void {
    if (!hasExplicitInvocationOverride(override)) {
      this.invocationCache.set(this.getInvocationCacheKey(context), invocation);
    }
  }

  private getInvocationCacheKey(context: ArchiverProviderSyncContext): string {
    return context.project.rootPath;
  }
}

function hasExplicitInvocationOverride(override?: ArchiverProviderOverride): boolean {
  return Boolean(
    override?.launchPreset?.trim() ||
    override?.executable?.trim() ||
    (override?.argsPrefix && override.argsPrefix.length > 0) ||
    (override?.inheritEnv && override.inheritEnv.length > 0) ||
    (override?.env && Object.keys(override.env).length > 0)
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueInvocations(invocations: ProviderInvocation[]): ProviderInvocation[] {
  const seen = new Set<string>();
  return invocations.filter(invocation => {
    const key = JSON.stringify([
      invocation.executable,
      invocation.argsPrefix,
      invocation.inheritEnv,
      invocation.env,
      invocation.managedVersion,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unavailableShellResult(args: string[], message: string): ProviderShellResult {
  return {
    success: false,
    args,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
    failureKind: 'not-found',
    error: message,
  };
}

export function firstNonEmptyLine(...values: string[]): string | undefined {
  for (const value of values) {
    const line = value
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean);
    if (line) return line;
  }
  return undefined;
}

export function formatShellFailure(result: ProviderShellResult): string {
  return result.error ?? firstNonEmptyLine(result.stderr, result.stdout) ?? '未知错误';
}
