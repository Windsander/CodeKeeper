import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getAppStorageDir } from '../../core/platform.js';
import type {
  ArchiverProviderDescriptor,
  ArchiverProviderManagedInvocation,
  ArchiverProviderManagedRuntime,
  ArchiverProviderPrepareResult,
  ArchiverProviderProvisioner,
} from './provider-types.js';
import type { ProviderCommandRunner, ProviderShellResult } from './provider-shell.js';

export interface ManagedProviderRuntimeOptions {
  rootDir?: string;
  shell: ProviderCommandRunner;
  platform?: NodeJS.Platform;
}

interface RuntimeMarker {
  schemaVersion: 1;
  providerId: string;
  kind: ArchiverProviderManagedRuntime['kind'];
  version: string;
  preparedAt: number;
}

interface BootstrapInvocation {
  executable: string;
  argsPrefix: string[];
}

const INSTALL_NETWORK_ENVIRONMENT_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** 将外部 Provider 安装到应用自有目录，避免污染用户全局运行时。 */
export class ManagedProviderRuntime implements ArchiverProviderProvisioner {
  private readonly rootDir: string;
  private readonly shell: ProviderCommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly preparations = new Map<string, Promise<ArchiverProviderPrepareResult>>();

  constructor(options: ManagedProviderRuntimeOptions) {
    this.rootDir = resolve(options.rootDir ?? join(getAppStorageDir(), 'providers', 'runtime'));
    this.shell = options.shell;
    this.platform = options.platform ?? process.platform;
  }

  async resolve(
    descriptor: ArchiverProviderDescriptor
  ): Promise<ArchiverProviderPrepareResult | null> {
    const specification = descriptor.managedRuntime;
    if (!specification) return null;

    const versionRoot = this.getVersionRoot(descriptor, specification);
    const marker = await this.readMarker(versionRoot);
    if (
      !marker ||
      marker.providerId !== descriptor.id ||
      marker.kind !== specification.kind ||
      marker.version !== specification.version
    ) {
      return null;
    }

    if (specification.kind === 'git-skill') {
      const repositoryRoot = join(versionRoot, 'repository');
      const skillPath = resolve(repositoryRoot, specification.skillPath);
      if (!isPathInside(repositoryRoot, skillPath) || !(await isFile(skillPath))) return null;
      return {
        providerId: descriptor.id,
        success: true,
        prepared: true,
        manual: true,
        version: specification.version,
        message: 'Skill 资源已由系统准备，等待 Agent 工作流调用',
        assetRoot: repositoryRoot,
      };
    }

    const invocation = await this.resolveCliInvocation(versionRoot, specification);
    if (!invocation) return null;
    return {
      providerId: descriptor.id,
      success: true,
      prepared: true,
      version: specification.version,
      message: '托管运行时已准备',
      invocation,
      assetRoot: versionRoot,
    };
  }

  async prepare(descriptor: ArchiverProviderDescriptor): Promise<ArchiverProviderPrepareResult> {
    const specification = descriptor.managedRuntime;
    if (!specification) {
      return {
        providerId: descriptor.id,
        success: false,
        prepared: false,
        message: 'Provider 未声明托管运行时',
      };
    }

    const key = `${descriptor.id}@${specification.version}`;
    const existing = this.preparations.get(key);
    if (existing) return existing;

    const preparation = this.prepareOnce(descriptor, specification).finally(() => {
      this.preparations.delete(key);
    });
    this.preparations.set(key, preparation);
    return preparation;
  }

  private async prepareOnce(
    descriptor: ArchiverProviderDescriptor,
    specification: ArchiverProviderManagedRuntime
  ): Promise<ArchiverProviderPrepareResult> {
    const resolved = await this.resolve(descriptor);
    if (resolved) return resolved;

    const versionRoot = this.getVersionRoot(descriptor, specification);
    await mkdir(versionRoot, { recursive: true });

    switch (specification.kind) {
      case 'python-package':
        return this.preparePythonPackage(descriptor, specification, versionRoot);
      case 'npm-package':
        return this.prepareNpmPackage(descriptor, specification, versionRoot);
      case 'git-skill':
        return this.prepareGitSkill(descriptor, specification, versionRoot);
    }
  }

  private async preparePythonPackage(
    descriptor: ArchiverProviderDescriptor,
    specification: Extract<ArchiverProviderManagedRuntime, { kind: 'python-package' }>,
    versionRoot: string
  ): Promise<ArchiverProviderPrepareResult> {
    const bootstrap = await this.findBootstrap(
      this.platform === 'win32'
        ? [
            { executable: 'python', argsPrefix: [] },
            { executable: 'py', argsPrefix: ['-3'] },
            { executable: 'python3', argsPrefix: [] },
          ]
        : [
            { executable: 'python3', argsPrefix: [] },
            { executable: 'python', argsPrefix: [] },
          ],
      versionRoot
    );
    if (!bootstrap) {
      return this.failure(descriptor, '未检测到可用于创建隔离环境的 Python 3');
    }

    const virtualEnvironment = join(versionRoot, 'venv');
    const managedPython = this.getManagedPythonPath(virtualEnvironment);
    if (!(await isFile(managedPython))) {
      const createResult = await this.shell.run({
        executable: bootstrap.executable,
        args: [...bootstrap.argsPrefix, '-m', 'venv', virtualEnvironment],
        cwd: versionRoot,
        inheritEnv: [...INSTALL_NETWORK_ENVIRONMENT_KEYS],
        env: { PYTHONUTF8: '1' },
        timeoutMs: 5 * 60 * 1000,
      });
      if (!createResult.success) return this.failure(descriptor, shellFailure(createResult));
    }

    const installResult = await this.shell.run({
      executable: managedPython,
      args: [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--no-input',
        '--upgrade',
        `${specification.packageName}==${specification.version}`,
      ],
      cwd: versionRoot,
      inheritEnv: [...INSTALL_NETWORK_ENVIRONMENT_KEYS],
      env: {
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_NO_INPUT: '1',
        PYTHONUTF8: '1',
      },
      timeoutMs: 30 * 60 * 1000,
      maxOutputBytes: 512 * 1024,
    });
    if (!installResult.success) return this.failure(descriptor, shellFailure(installResult));

    const invocation = await this.resolveCliInvocation(versionRoot, specification);
    if (!invocation) return this.failure(descriptor, '安装完成但未找到 Provider 入口');
    const verification = await this.verifyInvocation(invocation, versionRoot);
    if (!verification.success) return this.failure(descriptor, shellFailure(verification));

    await this.writeMarker(versionRoot, descriptor, specification);
    return {
      providerId: descriptor.id,
      success: true,
      prepared: true,
      version: specification.version,
      message: '已在应用隔离环境中自动准备 Provider',
      invocation,
      assetRoot: versionRoot,
    };
  }

  private async prepareNpmPackage(
    descriptor: ArchiverProviderDescriptor,
    specification: Extract<ArchiverProviderManagedRuntime, { kind: 'npm-package' }>,
    versionRoot: string
  ): Promise<ArchiverProviderPrepareResult> {
    const bootstrap = await this.findBootstrap(
      [{ executable: 'npm', argsPrefix: [] }],
      versionRoot
    );
    if (!bootstrap) return this.failure(descriptor, '未检测到 npm 运行时');

    const installResult = await this.shell.run({
      executable: bootstrap.executable,
      args: [
        ...bootstrap.argsPrefix,
        'install',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        '--prefix',
        versionRoot,
        `${specification.packageName}@${specification.version}`,
      ],
      cwd: versionRoot,
      inheritEnv: [...INSTALL_NETWORK_ENVIRONMENT_KEYS],
      env: { npm_config_update_notifier: 'false' },
      timeoutMs: 30 * 60 * 1000,
      maxOutputBytes: 512 * 1024,
    });
    if (!installResult.success) return this.failure(descriptor, shellFailure(installResult));

    const invocation = await this.resolveCliInvocation(versionRoot, specification);
    if (!invocation) return this.failure(descriptor, '安装完成但未找到 Provider 入口');
    const verification = await this.verifyInvocation(invocation, versionRoot, 2 * 60 * 1000);
    if (!verification.success) return this.failure(descriptor, shellFailure(verification));

    await this.writeMarker(versionRoot, descriptor, specification);
    return {
      providerId: descriptor.id,
      success: true,
      prepared: true,
      version: specification.version,
      message: '已在应用隔离环境中自动准备 Provider',
      invocation,
      assetRoot: versionRoot,
    };
  }

  private async prepareGitSkill(
    descriptor: ArchiverProviderDescriptor,
    specification: Extract<ArchiverProviderManagedRuntime, { kind: 'git-skill' }>,
    versionRoot: string
  ): Promise<ArchiverProviderPrepareResult> {
    const bootstrap = await this.findBootstrap(
      [{ executable: 'git', argsPrefix: [] }],
      versionRoot
    );
    if (!bootstrap) return this.failure(descriptor, '未检测到 Git，无法准备 Skill 资源');

    const repositoryRoot = join(versionRoot, 'repository');
    if (await pathExists(repositoryRoot)) {
      this.assertManagedPath(repositoryRoot);
      await rm(repositoryRoot, { recursive: true, force: true });
    }

    const cloneResult = await this.shell.run({
      executable: bootstrap.executable,
      args: [
        ...bootstrap.argsPrefix,
        'clone',
        '--depth',
        '1',
        '--branch',
        specification.revision,
        '--single-branch',
        specification.repository,
        repositoryRoot,
      ],
      cwd: versionRoot,
      inheritEnv: [...INSTALL_NETWORK_ENVIRONMENT_KEYS, 'GIT_SSL_CAINFO'],
      env: { GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: 15 * 60 * 1000,
      maxOutputBytes: 512 * 1024,
    });
    if (!cloneResult.success) return this.failure(descriptor, shellFailure(cloneResult));

    const skillPath = resolve(repositoryRoot, specification.skillPath);
    if (!isPathInside(repositoryRoot, skillPath) || !(await isFile(skillPath))) {
      return this.failure(descriptor, 'Skill 仓库中缺少约定入口');
    }

    await this.writeMarker(versionRoot, descriptor, specification);
    return {
      providerId: descriptor.id,
      success: true,
      prepared: true,
      manual: true,
      version: specification.version,
      message: 'Skill 已自动准备；执行阶段需要 Agent 工作流调度',
      assetRoot: repositoryRoot,
    };
  }

  private async findBootstrap(
    candidates: BootstrapInvocation[],
    cwd: string
  ): Promise<BootstrapInvocation | null> {
    for (const candidate of candidates) {
      const result = await this.shell.run({
        executable: candidate.executable,
        args: [...candidate.argsPrefix, '--version'],
        cwd,
        inheritEnv: [...INSTALL_NETWORK_ENVIRONMENT_KEYS],
        timeoutMs: 15_000,
        maxOutputBytes: 16 * 1024,
      });
      if (result.success) return candidate;
    }
    return null;
  }

  private async verifyInvocation(
    invocation: ArchiverProviderManagedInvocation,
    cwd: string,
    timeoutMs = 30_000
  ): Promise<ProviderShellResult> {
    return this.shell.run({
      executable: invocation.executable,
      args: [...invocation.argsPrefix, '--version'],
      cwd,
      inheritEnv: invocation.inheritEnv,
      env: invocation.env,
      timeoutMs,
      maxOutputBytes: 32 * 1024,
    });
  }

  private async resolveCliInvocation(
    versionRoot: string,
    specification: Exclude<ArchiverProviderManagedRuntime, { kind: 'git-skill' }>
  ): Promise<ArchiverProviderManagedInvocation | null> {
    const executable =
      specification.kind === 'python-package'
        ? await firstExistingFile(
            this.getPythonEntrypointCandidates(versionRoot, specification.entrypoint)
          )
        : await firstExistingFile(
            this.getNpmEntrypointCandidates(versionRoot, specification.entrypoint)
          );
    if (!executable) return null;
    return {
      executable,
      argsPrefix: [],
      inheritEnv: [...INSTALL_NETWORK_ENVIRONMENT_KEYS],
      version: specification.version,
    };
  }

  private getPythonEntrypointCandidates(versionRoot: string, entrypoint: string): string[] {
    const binRoot = join(versionRoot, 'venv', this.platform === 'win32' ? 'Scripts' : 'bin');
    return this.platform === 'win32'
      ? [join(binRoot, `${entrypoint}.exe`), join(binRoot, `${entrypoint}.cmd`)]
      : [join(binRoot, entrypoint)];
  }

  private getNpmEntrypointCandidates(versionRoot: string, entrypoint: string): string[] {
    const binRoot = join(versionRoot, 'node_modules', '.bin');
    return this.platform === 'win32'
      ? [join(binRoot, `${entrypoint}.cmd`), join(binRoot, `${entrypoint}.exe`)]
      : [join(binRoot, entrypoint)];
  }

  private getManagedPythonPath(virtualEnvironment: string): string {
    return join(
      virtualEnvironment,
      this.platform === 'win32' ? 'Scripts' : 'bin',
      this.platform === 'win32' ? 'python.exe' : 'python'
    );
  }

  private getVersionRoot(
    descriptor: ArchiverProviderDescriptor,
    specification: ArchiverProviderManagedRuntime
  ): string {
    return join(
      this.rootDir,
      safePathSegment(descriptor.id),
      safePathSegment(specification.version)
    );
  }

  private async readMarker(versionRoot: string): Promise<RuntimeMarker | null> {
    try {
      const parsed = JSON.parse(await readFile(join(versionRoot, 'ready.json'), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const marker = parsed as Partial<RuntimeMarker>;
      return marker.schemaVersion === 1 &&
        typeof marker.providerId === 'string' &&
        typeof marker.kind === 'string' &&
        typeof marker.version === 'string' &&
        Number.isFinite(marker.preparedAt)
        ? (marker as RuntimeMarker)
        : null;
    } catch {
      return null;
    }
  }

  private async writeMarker(
    versionRoot: string,
    descriptor: ArchiverProviderDescriptor,
    specification: ArchiverProviderManagedRuntime
  ): Promise<void> {
    const markerPath = join(versionRoot, 'ready.json');
    const temporaryPath = join(versionRoot, `ready.${process.pid}.${Date.now()}.tmp`);
    const marker: RuntimeMarker = {
      schemaVersion: 1,
      providerId: descriptor.id,
      kind: specification.kind,
      version: specification.version,
      preparedAt: Date.now(),
    };
    await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await rm(markerPath, { force: true });
    await rename(temporaryPath, markerPath);
  }

  private assertManagedPath(target: string): void {
    if (!isPathInside(this.rootDir, target)) {
      throw new Error('Provider 托管目录越界');
    }
  }

  private failure(
    descriptor: ArchiverProviderDescriptor,
    message: string
  ): ArchiverProviderPrepareResult {
    return {
      providerId: descriptor.id,
      success: false,
      prepared: false,
      message,
    };
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const pathFromRoot = relative(normalizedRoot, normalizedTarget);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function firstExistingFile(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (await isFile(path)) return path;
  }
  return null;
}

function shellFailure(result: ProviderShellResult): string {
  return (
    result.error ??
    firstNonEmptyLine(result.stderr, result.stdout) ??
    `Provider 命令失败，退出码 ${result.exitCode ?? 'null'}`
  );
}

function firstNonEmptyLine(...values: string[]): string | undefined {
  for (const value of values) {
    const line = value
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean);
    if (line) return line;
  }
  return undefined;
}
