import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodebaseMemoryProviderAdapter } from '../../../src/advance/archiver/adapters/codebase-memory-provider-adapter.js';
import { GraphifyProviderAdapter } from '../../../src/advance/archiver/adapters/graphify-provider-adapter.js';
import { RepowiseProviderAdapter } from '../../../src/advance/archiver/adapters/repowise-provider-adapter.js';
import { UnderstandAnythingProviderAdapter } from '../../../src/advance/archiver/adapters/understand-anything-provider-adapter.js';
import type { ArchiverProviderSyncContext } from '../../../src/advance/archiver/provider-types.js';
import type {
  ProviderCommandRunner,
  ProviderShellRequest,
  ProviderShellResult,
} from '../../../src/advance/archiver/provider-shell.js';

function successResult(request: ProviderShellRequest): ProviderShellResult {
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

describe('Archiver CLI Provider Adapters', () => {
  let workspace: string;
  let context: ArchiverProviderSyncContext;
  let requests: ProviderShellRequest[];
  let shell: ProviderCommandRunner;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'provider-adapters-'));
    context = {
      project: {
        id: 'project-test',
        name: 'project-test',
        rootPath: join(workspace, 'project'),
        registeredAt: Date.now(),
        lastScannedAt: null,
      },
      archiveRoot: join(workspace, 'archive'),
      providerDataRoot: join(workspace, 'archive', 'providers'),
    };
    mkdirSync(context.project.rootPath, { recursive: true });
    requests = [];
    shell = {
      run: vi.fn(async request => {
        requests.push(request);
        return successResult(request);
      }),
    };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('Graphify 使用外置输出目录执行可增量 extract', async () => {
    const adapter = new GraphifyProviderAdapter();
    const result = await adapter.sync(context, { shell }, { launchPreset: 'uvx' });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      executable: 'uvx',
      cwd: join(context.providerDataRoot, 'graphify'),
    });
    expect(requests[0].args).toEqual([
      '--from',
      'graphifyy',
      'graphify',
      'extract',
      context.project.rootPath,
      '--out',
      join(context.providerDataRoot, 'graphify'),
      '--no-viz',
      '--no-cluster',
      '--code-only',
    ]);
    expect(requests[0].inheritEnv).toContain('UV_CACHE_DIR');
    expect(requests[0].inheritEnv).not.toContain('UV_INDEX_URL');
    expect(requests[0].inheritEnv).not.toContain('HTTPS_PROXY');
    expect(result.artifacts).toEqual(['graphify/graphify-out/graph.json']);
  });

  it('Understand Anything 读取项目理解产物并提供查询上下文', async () => {
    const knowledgeRoot = join(context.project.rootPath, '.ua');
    mkdirSync(knowledgeRoot, { recursive: true });
    writeFileSync(
      join(knowledgeRoot, 'knowledge-graph.json'),
      JSON.stringify({
        summary: 'ReviewerRunner coordinates review findings and Maintainer applies fixes.',
      }),
      'utf8'
    );
    const adapter = new UnderstandAnythingProviderAdapter();

    const probe = await adapter.probe(context, { shell });
    const loaded = await adapter.loadContext?.(context, { shell }, { maxChars: 2000 });
    const queried = await adapter.query?.(
      context,
      { shell },
      { query: 'ReviewerRunner', limit: 2 }
    );

    expect(probe).toMatchObject({
      providerId: 'understand-anything',
      available: true,
      readiness: 'ready',
      prepared: true,
    });
    expect(loaded?.content).toContain('ReviewerRunner');
    expect(queried?.items.join('\n')).toContain('ReviewerRunner');
  });

  it('Graphify 已有图谱时仍保留外置输出并标记增量模式', async () => {
    const graphPath = join(context.providerDataRoot, 'graphify', 'graphify-out', 'graph.json');
    mkdirSync(join(context.providerDataRoot, 'graphify', 'graphify-out'), { recursive: true });
    writeFileSync(graphPath, '{}', 'utf8');

    const result = await new GraphifyProviderAdapter().sync(context, { shell });
    const extractRequest = requests.find(request => request.args?.includes('extract'));

    expect(extractRequest?.args?.[0]).toBe('extract');
    expect(extractRequest?.args).toContain('--out');
    expect(result.metadata).toEqual({ mode: 'incremental-extract' });
  });

  it('Graphify 从归档图谱提供静态上下文和结构查询', async () => {
    const graphRoot = join(context.providerDataRoot, 'graphify', 'graphify-out');
    mkdirSync(graphRoot, { recursive: true });
    writeFileSync(
      join(graphRoot, 'graph.json'),
      JSON.stringify({
        nodes: [
          {
            id: 'reviewer-runner',
            label: 'ReviewerRunner',
            file_type: 'class',
            source_file: 'virtual-src/reviewer-runner.ts',
            source_location: 'L10',
          },
          {
            id: 'load-role-context',
            label: 'loadRoleContext',
            file_type: 'function',
            source_file: 'virtual-src/base-role-runner.ts',
            source_location: 'L20',
          },
        ],
        links: [
          {
            source: 'reviewer-runner',
            target: 'load-role-context',
            relation: 'calls',
          },
        ],
      }),
      'utf8'
    );

    const adapter = new GraphifyProviderAdapter();
    const contextResult = await adapter.loadContext?.(context, { shell }, { maxChars: 2000 });
    const queryResult = await adapter.query?.(
      context,
      { shell },
      { query: 'ReviewerRunner 调用 loadRoleContext', limit: 2 }
    );

    expect(contextResult).toMatchObject({ success: true });
    expect(contextResult?.content).toContain('图谱节点 2 个');
    expect(queryResult).toMatchObject({ success: true });
    expect(queryResult?.items.join('\n')).toContain('ReviewerRunner');
    expect(queryResult?.items.join('\n')).toContain('calls→loadRoleContext');
  });

  it('统一合并启动覆盖、环境和 Provider 默认命令', async () => {
    await new GraphifyProviderAdapter().sync(
      context,
      { shell },
      {
        launchPreset: 'uvx',
        argsPrefix: ['--offline', '--from', 'graphifyy', 'graphify'],
        inheritEnv: ['UV_CACHE_DIR', 'PROVIDER_PROFILE'],
        env: { GRAPHIFY_NO_TIPS: '0', PROVIDER_MODE: 'custom' },
        timeoutMs: 1234,
      }
    );

    expect(requests[0].args?.slice(0, 4)).toEqual(['--offline', '--from', 'graphifyy', 'graphify']);
    expect(requests[0].inheritEnv?.filter(key => key === 'UV_CACHE_DIR')).toHaveLength(1);
    expect(requests[0].inheritEnv).toContain('PROVIDER_PROFILE');
    expect(requests[0].env).toMatchObject({
      GRAPHIFY_NO_TIPS: '0',
      PROVIDER_MODE: 'custom',
    });
    expect(requests[0].timeoutMs).toBe(1234);
  });

  it('codebase-memory-mcp 使用公开 flag 形式调用索引工具', async () => {
    const result = await new CodebaseMemoryProviderAdapter().sync(
      context,
      { shell },
      { launchPreset: 'python-module' }
    );

    expect(requests[0].executable).toBe('python');
    expect(requests[0].args).toEqual([
      '-m',
      'codebase_memory_mcp',
      'cli',
      'index_repository',
      '--repo-path',
      context.project.rootPath,
    ]);
    expect(requests[0].args).not.toContain('--json');
    expect(requests[0].env).toMatchObject({
      CBM_ALLOWED_ROOT: context.project.rootPath,
      CBM_CACHE_DIR: join(context.providerDataRoot, 'codebase-memory-mcp'),
      CBM_LOG_LEVEL: 'warn',
    });
    expect(requests[0].inheritEnv).toContain('VIRTUAL_ENV');
    expect(result.artifacts).toEqual(['codebase-memory-mcp']);
    expect(result.metadata).toEqual({ storage: 'archive-managed-cache' });
  });

  it('codebase-memory-mcp 将查询 JSON 放入 stdin 并解析结果', async () => {
    shell = {
      run: vi.fn(async request => {
        requests.push(request);
        if (request.args?.at(-1) === 'list_projects') {
          return {
            ...successResult(request),
            stdout: JSON.stringify({
              projects: [{ name: 'virtual-project', root_path: context.project.rootPath }],
            }),
          };
        }
        return {
          ...successResult(request),
          stdout: JSON.stringify({
            results: [
              {
                name: 'ProviderShell',
                type: 'Class',
                file_path: 'virtual-src/provider-shell.ts',
                summary: '统一命令执行层',
              },
            ],
          }),
        };
      }),
    };

    const result = await new CodebaseMemoryProviderAdapter().query?.(
      context,
      { shell },
      { query: 'Provider Shell', limit: 3 }
    );

    expect(
      requests.filter(request => !request.args?.includes('--version')).map(request => request.args)
    ).toEqual([
      ['cli', 'list_projects'],
      ['cli', 'semantic_query'],
    ]);
    const queryRequest = requests.find(request => request.args?.at(-1) === 'semantic_query');
    expect(JSON.parse(queryRequest?.stdin ?? '{}')).toEqual({
      project: 'virtual-project',
      query: 'Provider Shell',
      limit: 3,
    });
    expect(result?.items[0]).toContain('ProviderShell');
  });

  it('Repowise 仅更新已初始化实例并支持 uvx preset', async () => {
    mkdirSync(join(context.project.rootPath, '.repowise'), { recursive: true });

    const result = await new RepowiseProviderAdapter().sync(
      context,
      { shell },
      { launchPreset: 'uvx' }
    );

    expect(requests[0].executable).toBe('uvx');
    expect(requests[0].args).toEqual(['repowise', 'update', context.project.rootPath]);
    expect(result.artifacts).toEqual(['.repowise']);
  });

  it('Repowise 查询使用结构化 argv 和 JSON 输出', async () => {
    mkdirSync(join(context.project.rootPath, '.repowise'), { recursive: true });
    shell = {
      run: vi.fn(async request => {
        requests.push(request);
        return {
          ...successResult(request),
          stdout: JSON.stringify({
            results: [
              {
                type: 'symbol',
                name: 'ArchiverProviderOrchestrator',
                path: 'virtual-src/provider-orchestrator.ts',
              },
            ],
          }),
        };
      }),
    };

    const result = await new RepowiseProviderAdapter().query?.(
      context,
      { shell },
      { query: 'provider fallback', limit: 4 }
    );

    const searchRequest = requests.find(request => request.args?.[0] === 'search');
    expect(searchRequest?.args).toEqual([
      'search',
      '--format',
      'json',
      '--limit',
      '4',
      'provider fallback',
      context.project.rootPath,
    ]);
    expect(result?.items[0]).toContain('ArchiverProviderOrchestrator');
  });
});
