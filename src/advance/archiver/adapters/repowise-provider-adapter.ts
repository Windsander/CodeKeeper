import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ArchiverProviderDescriptor,
  ArchiverProviderOverride,
  ArchiverProviderQueryRequest,
  ArchiverProviderQueryResult,
  ArchiverProviderRuntime,
  ArchiverProviderSyncContext,
  ArchiverProviderSyncResult,
} from '../provider-types.js';
import { UV_LAUNCH_ENVIRONMENT_KEYS } from '../provider-launch.js';
import { formatProviderJsonItems, parseProviderJson } from '../provider-query-utils.js';
import { CliProviderAdapter, formatShellFailure } from './cli-provider-adapter.js';

export class RepowiseProviderAdapter extends CliProviderAdapter {
  readonly descriptor: ArchiverProviderDescriptor = {
    id: 'repowise',
    displayName: 'Repowise',
    description: '在用户已初始化的实例上补充 Git 历史、代码健康度和影响分析。',
    homepage: 'https://github.com/repowise-dev/repowise',
    license: 'AGPL-3.0-or-later',
    kind: 'cli',
    automation: 'managed',
    placements: ['enricher'],
    capabilities: ['code-structure', 'query', 'impact-analysis', 'git-history', 'code-health'],
    autoSelect: true,
    selectionPriority: 50,
    defaultExecutable: 'repowise',
    defaultLaunchPreset: 'installed',
    managedRuntime: {
      kind: 'python-package',
      packageName: 'repowise',
      version: '0.42.0',
      entrypoint: 'repowise',
    },
    launchPresets: [
      {
        id: 'installed',
        displayName: '已安装命令',
        description: '使用 PATH 中已有的 repowise 命令。',
        executable: 'repowise',
        argsPrefix: [],
      },
      {
        id: 'uvx',
        displayName: 'uvx 临时运行',
        description: '通过 PyPI 包临时运行，首次使用可能下载包。',
        executable: 'uvx',
        argsPrefix: ['repowise'],
        inheritEnv: [...UV_LAUNCH_ENVIRONMENT_KEYS],
      },
    ],
    licenseNotice: '该 Provider 使用 AGPL-3.0-or-later；启用前请确认部署与分发方式符合许可证要求。',
  };

  async sync(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult> {
    if (!existsSync(join(context.project.rootPath, '.repowise'))) {
      return {
        providerId: this.descriptor.id,
        success: true,
        skipped: true,
        message: '项目尚未初始化 Repowise，按 managed 模式跳过',
      };
    }

    const result = await this.runCommand(context, runtime, override, {
      args: ['update', context.project.rootPath],
      cwd: context.project.rootPath,
      env: {
        DO_NOT_TRACK: '1',
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
      message: 'Repowise 知识库已更新',
      artifacts: ['.repowise'],
    };
  }

  async query(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    request: ArchiverProviderQueryRequest,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderQueryResult> {
    if (!existsSync(join(context.project.rootPath, '.repowise'))) {
      return {
        providerId: this.descriptor.id,
        success: true,
        items: [],
        message: '项目尚未初始化 Repowise',
      };
    }
    const result = await this.runCommand(context, runtime, override, {
      args: [
        'search',
        '--format',
        'json',
        '--limit',
        String(request.limit ?? 6),
        request.query,
        context.project.rootPath,
      ],
      cwd: context.project.rootPath,
      env: { DO_NOT_TRACK: '1' },
      timeoutMs: 90_000,
      maxOutputBytes: 512 * 1024,
    });
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
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<boolean> {
    return existsSync(join(context.project.rootPath, '.repowise'));
  }
}
