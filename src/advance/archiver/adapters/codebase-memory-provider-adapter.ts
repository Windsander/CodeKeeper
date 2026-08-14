import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArchiverProviderContextRequest,
  ArchiverProviderContextResult,
  ArchiverProviderDescriptor,
  ArchiverProviderOverride,
  ArchiverProviderQueryRequest,
  ArchiverProviderQueryResult,
  ArchiverProviderRuntime,
  ArchiverProviderSyncContext,
  ArchiverProviderSyncResult,
} from '../provider-types.js';
import { PYTHON_LAUNCH_ENVIRONMENT_KEYS, UV_LAUNCH_ENVIRONMENT_KEYS } from '../provider-launch.js';
import { formatProviderJsonItems, parseProviderJson } from '../provider-query-utils.js';
import { CliProviderAdapter, formatShellFailure } from './cli-provider-adapter.js';

export class CodebaseMemoryProviderAdapter extends CliProviderAdapter {
  readonly descriptor: ArchiverProviderDescriptor = {
    id: 'codebase-memory-mcp',
    displayName: 'codebase-memory-mcp',
    description: '为代码库建立可查询索引，作为结构探索和影响分析的回退 Provider。',
    homepage: 'https://github.com/DeusData/codebase-memory-mcp',
    license: 'MIT',
    kind: 'cli',
    automation: 'full',
    placements: ['primary', 'fallback', 'enricher'],
    capabilities: ['code-structure', 'query', 'impact-analysis'],
    autoSelect: true,
    selectionPriority: 90,
    defaultExecutable: 'codebase-memory-mcp',
    defaultLaunchPreset: 'installed',
    managedRuntime: {
      kind: 'npm-package',
      packageName: 'codebase-memory-mcp',
      version: '0.10.3',
      entrypoint: 'codebase-memory-mcp',
    },
    launchPresets: [
      {
        id: 'installed',
        displayName: '已安装命令',
        description: '使用 PATH 中已有的原生或包装命令。',
        executable: 'codebase-memory-mcp',
        argsPrefix: [],
      },
      {
        id: 'uvx',
        displayName: 'uvx 临时运行',
        description: '通过 PyPI 包临时运行，首次使用可能下载原生运行时。',
        executable: 'uvx',
        argsPrefix: ['codebase-memory-mcp'],
        inheritEnv: [...UV_LAUNCH_ENVIRONMENT_KEYS],
      },
      {
        id: 'python-module',
        displayName: 'python -m',
        description: '使用当前 Python 环境中的包装模块。',
        executable: 'python',
        argsPrefix: ['-m', 'codebase_memory_mcp'],
        inheritEnv: [...PYTHON_LAUNCH_ENVIRONMENT_KEYS],
      },
    ],
  };

  async sync(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult> {
    const dataRoot = join(context.providerDataRoot, this.descriptor.id);
    await mkdir(dataRoot, { recursive: true });

    const result = await this.runCommand(context, runtime, override, {
      args: ['cli', 'index_repository', '--repo-path', context.project.rootPath],
      cwd: dataRoot,
      env: {
        CBM_ALLOWED_ROOT: context.project.rootPath,
        CBM_CACHE_DIR: dataRoot,
        CBM_LOG_LEVEL: 'warn',
      },
      timeoutMs: 30 * 60 * 1000,
    });

    if (!result.success) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: formatShellFailure(result),
      };
    }
    return {
      providerId: this.descriptor.id,
      success: true,
      message: 'codebase-memory-mcp 索引已更新',
      artifacts: [toArtifactPath(this.descriptor.id)],
      metadata: { storage: 'archive-managed-cache' },
    };
  }

  async loadContext(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    request: ArchiverProviderContextRequest,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderContextResult> {
    const projectName = await this.resolveProjectName(context, runtime, override);
    if (!projectName) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: '无法从 codebase-memory-mcp 解析当前项目索引',
      };
    }
    const result = await this.runTool(
      context,
      runtime,
      override,
      'get_architecture',
      { project: projectName },
      60_000
    );
    if (!result.success) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: formatShellFailure(result),
      };
    }
    try {
      return {
        providerId: this.descriptor.id,
        success: true,
        content: formatProviderJsonItems(
          parseProviderJson(result.stdout),
          12,
          request.maxChars ?? 8000
        ).join('\n'),
      };
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async query(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    request: ArchiverProviderQueryRequest,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderQueryResult> {
    const projectName = await this.resolveProjectName(context, runtime, override);
    if (!projectName) {
      return {
        providerId: this.descriptor.id,
        success: false,
        items: [],
        message: '无法从 codebase-memory-mcp 解析当前项目索引',
      };
    }
    const result = await this.runTool(
      context,
      runtime,
      override,
      'semantic_query',
      {
        project: projectName,
        query: request.query,
        limit: request.limit ?? 6,
      },
      90_000
    );
    if (!result.success) {
      return {
        providerId: this.descriptor.id,
        success: false,
        items: [],
        message: formatShellFailure(result),
      };
    }
    try {
      return {
        providerId: this.descriptor.id,
        success: true,
        items: formatProviderJsonItems(
          parseProviderJson(result.stdout),
          request.limit ?? 6,
          request.maxChars ?? 10000
        ),
      };
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        success: false,
        items: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async isReady(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<boolean> {
    if (!existsSync(join(context.providerDataRoot, this.descriptor.id))) return false;
    return (await this.resolveProjectName(context, runtime, override)) !== null;
  }

  private async resolveProjectName(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<string | null> {
    const result = await this.runTool(
      context,
      runtime,
      override,
      'list_projects',
      undefined,
      30_000
    );
    if (!result.success) return null;
    try {
      return findIndexedProjectName(parseProviderJson(result.stdout), context.project.rootPath);
    } catch {
      return null;
    }
  }

  private runTool(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override: ArchiverProviderOverride | undefined,
    tool: string,
    input: Record<string, unknown> | undefined,
    timeoutMs: number
  ) {
    const dataRoot = join(context.providerDataRoot, this.descriptor.id);
    return this.runCommand(context, runtime, override, {
      args: ['cli', tool],
      cwd: dataRoot,
      env: {
        CBM_ALLOWED_ROOT: context.project.rootPath,
        CBM_CACHE_DIR: dataRoot,
        CBM_LOG_LEVEL: 'warn',
      },
      stdin: input ? `${JSON.stringify(input)}\n` : undefined,
      timeoutMs,
      maxOutputBytes: 512 * 1024,
    });
  }
}

function findIndexedProjectName(value: unknown, rootPath: string): string | null {
  const records = collectRecords(value);
  const normalizedRoot = normalizeProviderPath(rootPath);
  const pathKeys = ['root_path', 'repo_path', 'path', 'rootPath', 'repoPath'];
  const nameKeys = ['name', 'project', 'project_name', 'projectName', 'id'];
  for (const record of records) {
    const candidatePath = pathKeys
      .map(key => record[key])
      .find(item => typeof item === 'string') as string | undefined;
    if (!candidatePath || normalizeProviderPath(candidatePath) !== normalizedRoot) continue;
    const candidateName = nameKeys
      .map(key => record[key])
      .find(item => typeof item === 'string') as string | undefined;
    if (candidateName?.trim()) return candidateName.trim();
  }
  if (records.length === 1) {
    const candidateName = nameKeys
      .map(key => records[0][key])
      .find(item => typeof item === 'string') as string | undefined;
    return candidateName?.trim() || null;
  }
  return null;
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(collectRecords);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const nested = Object.values(record).flatMap(item =>
    Array.isArray(item) || (item && typeof item === 'object') ? collectRecords(item) : []
  );
  return [record, ...nested];
}

function normalizeProviderPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function toArtifactPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/');
}
