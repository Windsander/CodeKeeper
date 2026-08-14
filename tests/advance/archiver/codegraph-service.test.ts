/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodeGraphClient,
  createArchiverProviderCoordinator,
} from '../../../src/advance/archiver/codegraph-client.js';
import {
  CodeGraphService,
  type CodeGraphServiceBackend,
} from '../../../src/advance/archiver/codegraph-service.js';
import type { ArchiverProviderExecution } from '../../../src/advance/archiver/provider-orchestrator.js';
import type {
  ArchiverProviderDescriptor,
  ArchiverProviderExecutionStrategy,
  ArchiverProviderRunReport,
} from '../../../src/advance/archiver/provider-types.js';
import type { Project } from '../../../src/advance/types.js';

const project: Project = {
  id: 'project-a',
  rootPath: 'virtual-project',
  archiveRoot: 'virtual-archive',
  name: 'Project A',
  registeredAt: 1,
  lastScannedAt: null,
};

const strategy: ArchiverProviderExecutionStrategy = {
  schemaVersion: 1,
  primary: 'graphify',
  fallbacks: ['builtin'],
  enrichers: [],
  builtinFallback: true,
};

const report: ArchiverProviderRunReport = {
  schemaVersion: 1,
  projectId: project.id,
  generatedAt: 1,
  selectedPrimary: 'graphify',
  statuses: [],
};

const execution: ArchiverProviderExecution = {
  report,
  shouldRunBuiltin: false,
  builtinRequired: false,
};

const descriptors: ArchiverProviderDescriptor[] = [
  {
    id: 'builtin',
    displayName: '内置知识提炼',
    description: '内置能力',
    homepage: 'builtin',
    license: 'MIT',
    kind: 'builtin',
    automation: 'full',
    placements: ['primary', 'fallback', 'enricher'],
    capabilities: ['documents', 'query'],
  },
  {
    id: 'graphify',
    displayName: 'Graphify',
    description: '代码图谱',
    homepage: 'https://example.invalid/graphify',
    license: 'MIT',
    kind: 'cli',
    automation: 'managed',
    placements: ['primary'],
    capabilities: ['code-structure', 'query'],
    managedRuntime: {
      kind: 'python-package',
      packageName: 'graphifyy',
      version: '0.9.42',
      entrypoint: 'graphify',
    },
  },
  {
    id: 'understand-anything',
    displayName: 'Understand Anything',
    description: 'Agent Skill',
    homepage: 'https://example.invalid/understand-anything',
    license: 'MIT',
    kind: 'skill',
    automation: 'manual',
    placements: ['enricher'],
    capabilities: ['code-structure', 'documents', 'query', 'interactive-skill'],
    managedRuntime: {
      kind: 'git-skill',
      repository: 'https://example.invalid/understand-anything.git',
      revision: 'v2.9.0',
      version: '2.9.0',
      skillPath: 'skills/understand/SKILL.md',
    },
  },
];

function createBackend(overrides: Partial<CodeGraphServiceBackend> = {}) {
  return {
    listProviders: vi.fn(() => descriptors),
    getAutomaticStrategy: vi.fn(() => strategy),
    prepareProvider: vi.fn(async providerId => ({
      providerId,
      success: true,
      prepared: true,
      version: providerId === 'graphify' ? '0.9.42' : '2.9.0',
      manual: providerId === 'understand-anything',
    })),
    probeProject: vi.fn(async () => []),
    readStatus: vi.fn(async () => report),
    hasProjectKnowledgeSource: vi.fn(async () => true),
    loadProjectKnowledgeContext: vi.fn(async () => '统一项目知识上下文'),
    queryProjectKnowledge: vi.fn(async () => ['统一查询结果']),
    syncProject: vi.fn(async () => execution),
    finalizeBuiltin: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as CodeGraphServiceBackend;
}

describe('CodeGraphService', () => {
  let service: CodeGraphService | null = null;

  afterEach(async () => {
    await service?.stop();
    service = null;
  });

  it('没有 Server 地址时只保留内置安全回退', () => {
    const coordinator = createArchiverProviderCoordinator('');
    expect((coordinator as { listProviders(): ArchiverProviderDescriptor[] }).listProviders()).toEqual([
      expect.objectContaining({ id: 'builtin' }),
    ]);
  });

  it('通过单一 HTTP Server 为角色进程转发同步与查询', async () => {
    const backend = createBackend();
    service = new CodeGraphService({
      registry: { get: projectId => (projectId === project.id ? project : null) },
      orchestrator: backend,
      autoPrepare: false,
    });
    const url = await service.start();
    const client = new CodeGraphClient({ baseUrl: url, timeoutMs: 2000 });

    await expect(client.syncProject(project, 'virtual-client-archive')).resolves.toEqual(execution);
    await expect(
      client.loadProjectKnowledgeContext(
        project,
        'virtual-client-archive',
        client.getAutomaticStrategy(),
        { maxChars: 1200 }
      )
    ).resolves.toBe('统一项目知识上下文');
    await expect(
      client.queryProjectKnowledge(
        project,
        'virtual-client-archive',
        client.getAutomaticStrategy(),
        { query: '依赖关系', role: 'reviewer', limit: 3 }
      )
    ).resolves.toEqual(['统一查询结果']);
    await client.finalizeBuiltin(
      project,
      'virtual-client-archive',
      report,
      true,
      '内置提炼完成'
    );

    expect(backend.syncProject).toHaveBeenCalledWith(project, 'virtual-archive', strategy);
    expect(backend.finalizeBuiltin).toHaveBeenCalledWith(
      project,
      'virtual-archive',
      report,
      true,
      '内置提炼完成'
    );
    expect(service.getStatus()).toMatchObject({
      state: 'running',
      url,
      activeJobs: 0,
      queuedJobs: 0,
    });
  });

  it('启动后自动准备托管 Provider，并保留 Skill 的 Agent 状态', async () => {
    const backend = createBackend();
    service = new CodeGraphService({
      registry: { get: () => project },
      orchestrator: backend,
      autoPrepare: true,
    });
    await service.start();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const states = service.getStatus().providers.map(provider => provider.state);
      if (!states.includes('preparing') && !states.includes('preparable')) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(service.getStatus().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: 'builtin', state: 'ready', prepared: true }),
        expect.objectContaining({ providerId: 'graphify', state: 'ready', prepared: true }),
        expect.objectContaining({
          providerId: 'understand-anything',
          state: 'manual',
          prepared: true,
        }),
      ])
    );
    expect(backend.prepareProvider).toHaveBeenCalledTimes(2);
  });

  it('同一项目的重复同步请求复用正在执行的任务', async () => {
    let resolveSync: ((value: ArchiverProviderExecution) => void) | undefined;
    const pending = new Promise<ArchiverProviderExecution>(resolve => {
      resolveSync = resolve;
    });
    const syncProject = vi.fn(() => pending);
    const backend = createBackend({ syncProject });
    service = new CodeGraphService({
      registry: { get: () => project },
      orchestrator: backend,
      autoPrepare: false,
    });

    const first = service.syncProject(project, 'virtual-archive', strategy);
    const second = service.syncProject(project, 'virtual-archive', strategy);

    expect(first).toBe(second);
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(service.getStatus().activeJobs).toBe(1);
    resolveSync?.(execution);
    await expect(Promise.all([first, second])).resolves.toEqual([execution, execution]);
    expect(service.getStatus().activeJobs).toBe(0);
  });
});
