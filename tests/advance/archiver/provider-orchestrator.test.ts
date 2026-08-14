import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodebaseMemoryProviderAdapter } from '../../../src/advance/archiver/adapters/codebase-memory-provider-adapter.js';
import { GraphifyProviderAdapter } from '../../../src/advance/archiver/adapters/graphify-provider-adapter.js';
import { UnderstandAnythingProviderAdapter } from '../../../src/advance/archiver/adapters/understand-anything-provider-adapter.js';
import { ArchiverProviderOrchestrator } from '../../../src/advance/archiver/provider-orchestrator.js';
import {
  ArchiverProviderRegistry,
  createDefaultArchiverProviderRegistry,
} from '../../../src/advance/archiver/provider-registry.js';
import type {
  ArchiverProviderAdapter,
  ArchiverProviderDescriptor,
  ArchiverProviderSyncResult,
} from '../../../src/advance/archiver/provider-types.js';
import type { ProviderCommandRunner } from '../../../src/advance/archiver/provider-shell.js';
import type { ArchiverProviderStrategy, Project } from '../../../src/advance/types.js';

function createAdapter(
  id: string,
  sync: () => Promise<ArchiverProviderSyncResult>,
  options: Partial<ArchiverProviderDescriptor> = {}
): ArchiverProviderAdapter {
  return {
    descriptor: {
      id,
      displayName: id,
      description: '',
      homepage: '',
      license: 'MIT',
      kind: 'cli',
      automation: 'full',
      placements: ['primary', 'fallback', 'enricher'],
      capabilities: ['code-structure'],
      defaultExecutable: id,
      ...options,
    },
    probe: vi.fn().mockResolvedValue({ providerId: id, available: true, version: 'test' }),
    sync: vi.fn(sync),
  };
}

const unusedShell: ProviderCommandRunner = {
  run: vi.fn(),
};

describe('ArchiverProviderOrchestrator', () => {
  let workspace: string;
  let project: Project;
  let archiveRoot: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'provider-orchestrator-'));
    archiveRoot = join(workspace, 'archive');
    project = {
      id: 'project-test',
      name: 'project-test',
      rootPath: workspace,
      registeredAt: Date.now(),
      lastScannedAt: null,
    };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('自动策略按系统优先级选择主 Provider，并保留增强与内置阶段', () => {
    const strategy = createDefaultArchiverProviderRegistry().createAutomaticStrategy();

    expect(strategy.primary).toBe('graphify');
    expect(strategy.fallbacks).toEqual(['codebase-memory-mcp']);
    expect(strategy.enrichers).toEqual(['builtin', 'repowise', 'understand-anything']);
    expect(strategy.builtinFallback).toBe(true);
    expect(strategy.primary).not.toBe('understand-anything');
    expect(strategy.fallbacks).not.toContain('understand-anything');
  });

  it('探测项目时自动准备 Understand Anything Skill 资源', async () => {
    const adapter = new UnderstandAnythingProviderAdapter();
    let prepared = false;
    const provisioner = {
      resolve: vi.fn(async descriptor =>
        prepared
          ? {
              providerId: descriptor.id,
              success: true,
              prepared: true,
              manual: true,
              version: '2.9.0',
            }
          : null
      ),
      prepare: vi.fn(async descriptor => {
        prepared = true;
        return {
          providerId: descriptor.id,
          success: true,
          prepared: true,
          manual: true,
          version: '2.9.0',
        };
      }),
    };
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([adapter]),
      shell: unusedShell,
      provisioner,
    });

    const results = await orchestrator.probeProject(project, archiveRoot);

    expect(provisioner.prepare).toHaveBeenCalledWith(adapter.descriptor);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'understand-anything',
          available: false,
          readiness: 'manual',
          prepared: true,
        }),
      ])
    );
  });

  it('同步项目时自动准备手动 Skill 增强源', async () => {
    const adapter = new UnderstandAnythingProviderAdapter();
    let prepared = false;
    const provisioner = {
      resolve: vi.fn(async descriptor =>
        prepared
          ? {
              providerId: descriptor.id,
              success: true,
              prepared: true,
              manual: true,
              version: '2.9.0',
            }
          : null
      ),
      prepare: vi.fn(async descriptor => {
        prepared = true;
        return {
          providerId: descriptor.id,
          success: true,
          prepared: true,
          manual: true,
          version: '2.9.0',
        };
      }),
    };
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([adapter]),
      shell: unusedShell,
      provisioner,
    });

    const execution = await orchestrator.syncProject(project, archiveRoot, {
      schemaVersion: 1,
      primary: 'builtin',
      fallbacks: [],
      enrichers: ['understand-anything'],
      builtinFallback: true,
    });

    expect(provisioner.prepare).toHaveBeenCalledWith(adapter.descriptor);
    expect(execution.report.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'understand-anything',
          placement: 'enricher',
          state: 'deferred',
          version: '2.9.0',
        }),
      ])
    );
  });

  it('首选 Provider 失败后按顺序选择回退 Provider', async () => {
    const primary = createAdapter('primary-provider', async () => ({
      providerId: 'primary-provider',
      success: false,
      message: '同步失败',
    }));
    const fallback = createAdapter('fallback-provider', async () => ({
      providerId: 'fallback-provider',
      success: true,
    }));
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([primary, fallback]),
      shell: unusedShell,
    });
    const strategy: ArchiverProviderStrategy = {
      schemaVersion: 1,
      primary: 'primary-provider',
      fallbacks: [' fallback-provider '],
      enrichers: [],
      builtinFallback: true,
    };

    const execution = await orchestrator.syncProject(project, archiveRoot, strategy);

    expect(execution.report.selectedPrimary).toBe('fallback-provider');
    expect(execution.shouldRunBuiltin).toBe(false);
    expect(execution.builtinRequired).toBe(false);
    expect(execution.report.statuses.map(status => status.state)).toEqual(['failed', 'completed']);
  });

  it('外部 Provider 均不可用时延后执行内置阶段并持久化结果', async () => {
    const unavailable = createAdapter('unavailable-provider', async () => ({
      providerId: 'unavailable-provider',
      success: true,
    }));
    unavailable.probe = vi.fn().mockResolvedValue({
      providerId: 'unavailable-provider',
      available: false,
      message: '不可用',
    });
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([unavailable]),
      shell: unusedShell,
    });
    const strategy: ArchiverProviderStrategy = {
      schemaVersion: 1,
      primary: 'unavailable-provider',
      fallbacks: [],
      enrichers: [],
      builtinFallback: true,
    };

    const execution = await orchestrator.syncProject(project, archiveRoot, strategy);
    expect(execution.report.selectedPrimary).toBe('builtin');
    expect(execution.shouldRunBuiltin).toBe(true);
    expect(execution.builtinRequired).toBe(true);
    expect(execution.report.statuses.at(-1)?.state).toBe('deferred');

    await orchestrator.finalizeBuiltin(
      project,
      archiveRoot,
      execution.report,
      true,
      '内置阶段完成'
    );
    const persisted = JSON.parse(
      await readFile(join(archiveRoot, 'providers', 'status.json'), 'utf8')
    ) as { statuses: Array<{ providerId: string; state: string; message?: string }> };
    expect(persisted.statuses.at(-1)).toMatchObject({
      providerId: 'builtin',
      state: 'completed',
      message: '内置阶段完成',
    });
  });

  it('增强 Provider 失败不会推翻已选中的主 Provider', async () => {
    const primary = createAdapter('primary-provider', async () => ({
      providerId: 'primary-provider',
      success: true,
    }));
    const enricher = createAdapter('enricher-provider', async () => {
      throw new Error('增强失败');
    });
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([primary, enricher]),
      shell: unusedShell,
    });
    const strategy: ArchiverProviderStrategy = {
      schemaVersion: 1,
      primary: 'primary-provider',
      fallbacks: [],
      enrichers: ['enricher-provider'],
      builtinFallback: true,
    };

    const execution = await orchestrator.syncProject(project, archiveRoot, strategy);

    expect(execution.report.selectedPrimary).toBe('primary-provider');
    expect(execution.builtinRequired).toBe(false);
    expect(execution.report.statuses).toEqual([
      expect.objectContaining({ providerId: 'primary-provider', state: 'completed' }),
      expect.objectContaining({ providerId: 'enricher-provider', state: 'failed' }),
    ]);
  });

  it('内置增强阶段不会被标记为主流程必需', async () => {
    const primary = createAdapter('primary-provider', async () => ({
      providerId: 'primary-provider',
      success: true,
    }));
    const builtin = createAdapter('builtin', async () => ({
      providerId: 'builtin',
      success: true,
      skipped: true,
    }));
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([primary, builtin]),
      shell: unusedShell,
    });

    const execution = await orchestrator.syncProject(project, archiveRoot, {
      schemaVersion: 1,
      primary: 'primary-provider',
      fallbacks: [],
      enrichers: ['builtin'],
      builtinFallback: true,
    });

    expect(execution.shouldRunBuiltin).toBe(true);
    expect(execution.builtinRequired).toBe(false);
    expect(execution.report.statuses.at(-1)).toMatchObject({
      providerId: 'builtin',
      placement: 'enricher',
      state: 'deferred',
    });
  });

  it('关闭内置回退且主 Provider 失败时不执行内置增强', async () => {
    const primary = createAdapter('primary-provider', async () => ({
      providerId: 'primary-provider',
      success: false,
      message: '同步失败',
    }));
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([primary]),
      shell: unusedShell,
    });

    const execution = await orchestrator.syncProject(project, archiveRoot, {
      schemaVersion: 1,
      primary: 'primary-provider',
      fallbacks: [],
      enrichers: ['builtin'],
      builtinFallback: false,
    });

    expect(execution.report.selectedPrimary).toBe('');
    expect(execution.shouldRunBuiltin).toBe(false);
    expect(execution.builtinRequired).toBe(false);
    expect(execution.report.statuses).toEqual([
      expect.objectContaining({ providerId: 'primary-provider', state: 'failed' }),
    ]);
  });

  it('本轮同步失败后仍可查询上一轮成功生成的 Graphify 图谱', async () => {
    const providerRoot = join(archiveRoot, 'providers');
    const graphRoot = join(providerRoot, 'graphify', 'graphify-out');
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
          },
        ],
        links: [],
      }),
      'utf8'
    );
    writeFileSync(
      join(providerRoot, 'status.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: project.id,
        generatedAt: Date.now(),
        selectedPrimary: 'builtin',
        statuses: [
          {
            providerId: 'graphify',
            placement: 'primary',
            state: 'failed',
            startedAt: 1,
            finishedAt: 2,
            message: '本轮同步失败',
          },
        ],
      }),
      'utf8'
    );
    const shell = { run: vi.fn() } as unknown as ProviderCommandRunner;
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([new GraphifyProviderAdapter()]),
      shell,
    });

    const items = await orchestrator.queryProjectKnowledge(
      project,
      archiveRoot,
      {
        schemaVersion: 1,
        primary: 'graphify',
        fallbacks: [],
        enrichers: [],
        builtinFallback: true,
      },
      { query: 'ReviewerRunner' }
    );

    expect(items.join('\n')).toContain('[Graphify]');
    expect(items.join('\n')).toContain('ReviewerRunner');
    expect(shell.run).not.toHaveBeenCalled();
  });

  it('尚无编排状态时也能消费已有的手动 Skill 图谱', async () => {
    const knowledgeRoot = join(project.rootPath, '.ua');
    mkdirSync(knowledgeRoot, { recursive: true });
    writeFileSync(
      join(knowledgeRoot, 'knowledge-graph.json'),
      JSON.stringify({ summary: 'ReviewerRunner coordinates project review knowledge.' }),
      'utf8'
    );
    const shell = { run: vi.fn() } as unknown as ProviderCommandRunner;
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([new UnderstandAnythingProviderAdapter()]),
      shell,
    });

    const items = await orchestrator.queryProjectKnowledge(
      project,
      archiveRoot,
      {
        schemaVersion: 1,
        primary: 'builtin',
        fallbacks: [],
        enrichers: [],
        builtinFallback: true,
      },
      { query: 'ReviewerRunner' }
    );

    expect(items.join('\n')).toContain('[Understand Anything]');
    expect(items.join('\n')).toContain('ReviewerRunner');
    expect(shell.run).not.toHaveBeenCalled();
  });

  it('没有 Provider 状态时不会为了就绪探测启动外部 CLI', async () => {
    mkdirSync(join(archiveRoot, 'providers', 'codebase-memory-mcp'), { recursive: true });
    const shell = { run: vi.fn() } as unknown as ProviderCommandRunner;
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([new CodebaseMemoryProviderAdapter()]),
      shell,
    });

    const available = await orchestrator.hasProjectKnowledgeSource(project, archiveRoot, {
      schemaVersion: 1,
      primary: 'codebase-memory-mcp',
      fallbacks: [],
      enrichers: [],
      builtinFallback: true,
    });

    expect(available).toBe(false);
    expect(shell.run).not.toHaveBeenCalled();
  });

  it('忽略结构不完整的 Provider 状态文件', async () => {
    const providerRoot = join(archiveRoot, 'providers');
    mkdirSync(providerRoot, { recursive: true });
    writeFileSync(
      join(providerRoot, 'status.json'),
      JSON.stringify({ schemaVersion: 1, projectId: project.id }),
      'utf8'
    );
    const shell = { run: vi.fn() } as unknown as ProviderCommandRunner;
    const orchestrator = new ArchiverProviderOrchestrator({
      registry: new ArchiverProviderRegistry([new CodebaseMemoryProviderAdapter()]),
      shell,
    });

    const status = await orchestrator.readStatus(archiveRoot);
    const available = await orchestrator.hasProjectKnowledgeSource(project, archiveRoot, {
      schemaVersion: 1,
      primary: 'codebase-memory-mcp',
      fallbacks: [],
      enrichers: [],
      builtinFallback: true,
    });

    expect(status).toBeNull();
    expect(available).toBe(false);
    expect(shell.run).not.toHaveBeenCalled();
  });
});
