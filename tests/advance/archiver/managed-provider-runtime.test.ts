import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedProviderRuntime } from '../../../src/advance/archiver/managed-provider-runtime.js';
import type {
  ArchiverProviderDescriptor,
  ArchiverProviderManagedRuntime,
} from '../../../src/advance/archiver/provider-types.js';
import type {
  ProviderCommandRunner,
  ProviderShellRequest,
  ProviderShellResult,
} from '../../../src/advance/archiver/provider-shell.js';

class RecordingRunner implements ProviderCommandRunner {
  readonly requests: ProviderShellRequest[] = [];

  constructor(private readonly onRun?: (request: ProviderShellRequest) => Promise<void> | void) {}

  async run(request: ProviderShellRequest): Promise<ProviderShellResult> {
    this.requests.push({ ...request, args: [...(request.args ?? [])] });
    await this.onRun?.(request);
    return {
      success: true,
      executable: request.executable,
      args: [...(request.args ?? [])],
      exitCode: 0,
      signal: null,
      stdout: 'provider 1.0.0',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    };
  }
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ManagedProviderRuntime', () => {
  it('在隔离 Python 环境中安装并缓存 Provider', async () => {
    const runtimeRoot = createTemporaryRoot('managed-python-');
    const versionRoot = join(runtimeRoot, 'virtual-python', '1.2.3');
    const binaryDirectory = process.platform === 'win32' ? 'Scripts' : 'bin';
    mkdirSync(versionRoot, { recursive: true });
    writeFileSync(join(versionRoot, 'ready.json'), '{schemaVersion:1,version:stale}', 'utf8');
    const runner = new RecordingRunner(request => {
      if (request.args?.includes('venv')) {
        const venvDirectory = join(versionRoot, 'venv', binaryDirectory);
        mkdirSync(venvDirectory, { recursive: true });
        writeFileSync(
          join(venvDirectory, process.platform === 'win32' ? 'python.exe' : 'python'),
          ''
        );
      }
      if (request.args?.includes('pip')) {
        const venvDirectory = join(versionRoot, 'venv', binaryDirectory);
        mkdirSync(venvDirectory, { recursive: true });
        writeFileSync(
          join(venvDirectory, process.platform === 'win32' ? 'virtual-tool.exe' : 'virtual-tool'),
          ''
        );
      }
    });
    const runtime = new ManagedProviderRuntime({ rootDir: runtimeRoot, shell: runner });
    const descriptor = createDescriptor({
      kind: 'python-package',
      packageName: 'virtual-package',
      version: '1.2.3',
      entrypoint: 'virtual-tool',
    });

    const result = await runtime.prepare(descriptor);

    expect(result.success).toBe(true);
    expect(result.prepared).toBe(true);
    expect(existsSync(join(versionRoot, 'ready.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(versionRoot, 'ready.json'), 'utf8'))).toMatchObject({
      providerId: 'virtual-python',
      version: '1.2.3',
    });
    const installRequest = runner.requests.find(request => request.args?.includes('pip'));
    expect(installRequest?.args).toEqual(
      expect.arrayContaining(['install', '--no-input', 'virtual-package==1.2.3'])
    );
    expect(installRequest?.inheritEnv).toContain('HTTPS_PROXY');
    expect(installRequest?.inheritEnv).not.toContain('PRIVATE_PROVIDER_TOKEN');

    const cached = await runtime.resolve(descriptor);
    expect(cached?.prepared).toBe(true);
    expect(cached?.invocation?.version).toBe('1.2.3');
    expect(runner.requests.filter(request => request.args?.includes('pip'))).toHaveLength(1);
  });

  it('并发准备同一 Provider 时只执行一次安装', async () => {
    const runtimeRoot = createTemporaryRoot('managed-concurrent-');
    const versionRoot = join(runtimeRoot, 'virtual-python', '2.0.0');
    const binaryDirectory = process.platform === 'win32' ? 'Scripts' : 'bin';
    let installCount = 0;
    let releaseInstall: (() => void) | undefined;
    const installStarted = new Promise<void>(resolve => {
      releaseInstall = resolve;
    });
    const runner = new RecordingRunner(async request => {
      if (request.args?.includes('venv')) {
        const venvDirectory = join(versionRoot, 'venv', binaryDirectory);
        mkdirSync(venvDirectory, { recursive: true });
        writeFileSync(
          join(venvDirectory, process.platform === 'win32' ? 'python.exe' : 'python'),
          ''
        );
      }
      if (request.args?.includes('pip')) {
        installCount += 1;
        releaseInstall?.();
        await new Promise(resolve => setTimeout(resolve, 10));
        const venvDirectory = join(versionRoot, 'venv', binaryDirectory);
        mkdirSync(venvDirectory, { recursive: true });
        writeFileSync(
          join(venvDirectory, process.platform === 'win32' ? 'virtual-tool.exe' : 'virtual-tool'),
          ''
        );
      }
    });
    const runtime = new ManagedProviderRuntime({ rootDir: runtimeRoot, shell: runner });
    const descriptor = createDescriptor({
      kind: 'python-package',
      packageName: 'virtual-package',
      version: '2.0.0',
      entrypoint: 'virtual-tool',
    });

    const first = runtime.prepare(descriptor);
    await installStarted;
    const second = runtime.prepare(descriptor);
    const results = await Promise.all([first, second]);

    expect(results.every(result => result.success && result.prepared)).toBe(true);
    expect(installCount).toBe(1);
  });

  it('为 npm Provider 使用应用目录并兼容 Windows bin 启动器', async () => {
    const runtimeRoot = createTemporaryRoot('managed-npm-');
    const versionRoot = join(runtimeRoot, 'virtual-npm', '3.4.5');
    const runner = new RecordingRunner(request => {
      if (request.args?.includes('install')) {
        const binDirectory = join(versionRoot, 'node_modules', '.bin');
        mkdirSync(binDirectory, { recursive: true });
        writeFileSync(
          join(binDirectory, process.platform === 'win32' ? 'virtual-tool.cmd' : 'virtual-tool'),
          ''
        );
      }
    });
    const runtime = new ManagedProviderRuntime({ rootDir: runtimeRoot, shell: runner });
    const descriptor = createDescriptor({
      kind: 'npm-package',
      packageName: 'virtual-package',
      version: '3.4.5',
      entrypoint: 'virtual-tool',
    });

    const result = await runtime.prepare(descriptor);

    expect(result.success).toBe(true);
    const installRequest = runner.requests.find(request => request.args?.includes('install'));
    const prefixIndex = installRequest?.args?.indexOf('--prefix') ?? -1;
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(installRequest?.args?.[prefixIndex + 1]).toBe(versionRoot);
    expect(installRequest?.args?.at(-1)).toBe('virtual-package@3.4.5');
    expect(result.invocation?.executable).toContain(join('node_modules', '.bin'));
  });

  it('自动准备 Understand Anything Skill 资源但拒绝越界入口', async () => {
    const runtimeRoot = createTemporaryRoot('managed-skill-');
    const repositoryRoot = join(runtimeRoot, 'virtual-skill', '2.9.0', 'repository');
    const runner = new RecordingRunner(request => {
      if (request.args?.includes('clone')) {
        mkdirSync(join(repositoryRoot, 'skills', 'understand'), { recursive: true });
        writeFileSync(join(repositoryRoot, 'skills', 'understand', 'SKILL.md'), '# Skill');
      }
    });
    const runtime = new ManagedProviderRuntime({ rootDir: runtimeRoot, shell: runner });
    const descriptor = createDescriptor({
      kind: 'git-skill',
      repository: 'https://example.invalid/virtual-skill.git',
      revision: 'v2.9.0',
      version: '2.9.0',
      skillPath: 'skills/understand/SKILL.md',
    });

    const prepared = await runtime.prepare(descriptor);

    expect(prepared.success).toBe(true);
    expect(prepared.manual).toBe(true);
    const cloneRequest = runner.requests.find(request => request.args?.includes('clone'));
    expect(cloneRequest?.args).toEqual(
      expect.arrayContaining([
        '--depth',
        '1',
        '--branch',
        'v2.9.0',
        descriptor.managedRuntime?.repository ?? '',
      ])
    );

    const unsafeDescriptor = createDescriptor({
      kind: 'git-skill',
      repository: 'https://example.invalid/virtual-skill.git',
      revision: 'v2.9.0',
      version: '2.9.0-unsafe',
      skillPath: '../outside/SKILL.md',
    });
    const unsafeResult = await runtime.prepare(unsafeDescriptor);
    expect(unsafeResult.success).toBe(false);
    expect(unsafeResult.message).toContain('约定入口');
  });
});

function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function createDescriptor(
  managedRuntime: ArchiverProviderManagedRuntime
): ArchiverProviderDescriptor {
  return {
    id:
      managedRuntime.kind === 'git-skill'
        ? 'virtual-skill'
        : managedRuntime.kind === 'npm-package'
          ? 'virtual-npm'
          : 'virtual-python',
    displayName: 'Virtual Provider',
    description: '测试用 Provider',
    homepage: 'https://example.invalid/provider',
    license: 'MIT',
    kind: managedRuntime.kind === 'git-skill' ? 'skill' : 'cli',
    automation: managedRuntime.kind === 'git-skill' ? 'manual' : 'full',
    placements: ['primary', 'fallback', 'enricher'],
    capabilities: ['code-structure'],
    managedRuntime,
  };
}
