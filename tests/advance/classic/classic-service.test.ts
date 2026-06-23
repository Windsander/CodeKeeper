/**
 * ClassicService 单元测试
 *
 * 验证调度器模式下的子进程生命周期管理。
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ClassicService } from '../../../src/advance/classic/classic-service.js';
import type { MetadataStore } from '../../../src/advance/store/metadata-store.js';
import type { ProjectRegistry } from '../../../src/advance/project-registry.js';
import type { Project } from '../../../src/advance/types.js';

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: overrides?.id ?? 'p1',
    rootPath: overrides?.rootPath ?? '/path/p1',
    name: overrides?.name ?? 'project-1',
    registeredAt: Date.now(),
    lastScannedAt: null,
    archiveRoot: overrides?.archiveRoot,
    gitlab: overrides?.gitlab,
    mrReview: overrides?.mrReview,
  };
}

function makeMockOptions(overrides?: {
  spawn?: Mock;
  registryList?: ProjectRegistry['list'];
}): ConstructorParameters<typeof ClassicService>[0] {
  return {
    store: {} as MetadataStore,
    registry: {
      list: overrides?.registryList ?? vi.fn(() => []),
    } as unknown as ProjectRegistry,
    getDaemonConfig: vi.fn(() => ({
      apiKey: 'test-key',
      provider: 'anthropic' as const,
      model: 'claude-3-5-sonnet',
      apiUrl: 'https://api.anthropic.com',
    })),
    spawn: overrides?.spawn,
  };
}

describe('ClassicService', () => {
  let spawnMock: Mock;
  let mockStdout: { on: Mock };
  let mockStderr: { on: Mock };
  let mockOn: Mock;
  let mockKill: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStdout = { on: vi.fn() };
    mockStderr = { on: vi.fn() };
    mockOn = vi.fn();
    mockKill = vi.fn();

    spawnMock = vi.fn(() =>
      ({
        stdout: mockStdout,
        stderr: mockStderr,
        on: mockOn,
        kill: mockKill,
        killed: false,
      })
    ) as Mock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start 应启动调度服务并为启用项目 spawn 子进程', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
        makeProject({
          id: 'p2',
          name: 'project-2',
          rootPath: '/path/p2',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p2', token: 'token2' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    expect(service.isRunning()).toBe(false);

    service.start();

    expect(service.isRunning()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('start 在已运行时不应重复 spawn', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    service.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('reconcile 会跳过未启用或未配置 GitLab 的项目', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
        makeProject({
          id: 'p2',
          name: 'project-2',
          rootPath: '/path/p2',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p2', token: 'token2' },
          mrReview: { enabled: false, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
        makeProject({
          id: 'p3',
          name: 'project-3',
          rootPath: '/path/p3',
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const project = JSON.parse(spawnMock.mock.calls[0][2].env.CK_PROJECTS_JSON);
    expect(project[0].id).toBe('p1');
  });

  it('调度周期到达时会自动 reconcile 新增项目', () => {
    let projects: Project[] = [
      makeProject({
        id: 'p1',
        name: 'project-1',
        rootPath: '/path/p1',
        gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
        mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
      }),
    ];

    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => projects),
    });

    const service = new ClassicService(options);
    service.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    projects = [
      ...projects,
      makeProject({
        id: 'p2',
        name: 'project-2',
        rootPath: '/path/p2',
        gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p2', token: 'token2' },
        mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
      }),
    ];

    vi.advanceTimersByTime(1100);

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('reconcile 会停止已禁用的项目 Agent', () => {
    let projects: Project[] = [
      makeProject({
        id: 'p1',
        name: 'project-1',
        rootPath: '/path/p1',
        gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
        mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
      }),
    ];

    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => projects),
    });

    const service = new ClassicService(options);
    service.start();
    expect(service.isProjectRunning('p1')).toBe(true);

    projects = [
      makeProject({
        id: 'p1',
        name: 'project-1',
        rootPath: '/path/p1',
        gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
        mrReview: { enabled: false, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
      }),
    ];

    vi.advanceTimersByTime(1100);

    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(service.isProjectRunning('p1')).toBe(false);
  });

  it('stop 会停止调度服务并杀掉所有子进程', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
        makeProject({
          id: 'p2',
          name: 'project-2',
          rootPath: '/path/p2',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p2', token: 'token2' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();
    expect(service.isRunning()).toBe(true);

    service.stop();

    expect(service.isRunning()).toBe(false);
    expect(mockKill).toHaveBeenCalledTimes(2);
  });

  it('restart 应先 stop 再 start', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    service.restart();

    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('restartProject 会重启指定项目的 Agent', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
        makeProject({
          id: 'p2',
          name: 'project-2',
          rootPath: '/path/p2',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p2', token: 'token2' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    service.restartProject('p2');

    expect(mockKill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const lastProject = JSON.parse(spawnMock.mock.calls[2][2].env.CK_PROJECTS_JSON);
    expect(lastProject[0].id).toBe('p2');
  });

  it('子进程 exit 后状态会同步', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();
    expect(service.isProjectRunning('p1')).toBe(true);

    const exitCallback = mockOn.mock.calls.find(
      (call) => call[0] === 'exit'
    )?.[1];
    expect(exitCallback).toBeDefined();

    exitCallback(0);
    expect(service.isProjectRunning('p1')).toBe(false);
    expect(service.getRunningProjectIds()).toEqual([]);
  });

  it('getRunningProjectIds 应返回运行中项目 ID 列表', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
        makeProject({
          id: 'p2',
          name: 'project-2',
          rootPath: '/path/p2',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p2', token: 'token2' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();

    expect(service.getRunningProjectIds().sort()).toEqual(['p1', 'p2']);
  });

  it('子进程 stdout/stderr 数据应被转发到 logger', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        makeProject({
          id: 'p1',
          name: 'project-1',
          rootPath: '/path/p1',
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '*/10 * * * *', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM', agentRole: 'reviewer' },
        }),
      ]),
    });

    const service = new ClassicService(options);
    service.start();

    const stdoutCallback = mockStdout.on.mock.calls.find(
      (call) => call[0] === 'data'
    )?.[1];
    const stderrCallback = mockStderr.on.mock.calls.find(
      (call) => call[0] === 'data'
    )?.[1];

    expect(stdoutCallback).toBeDefined();
    expect(stderrCallback).toBeDefined();

    expect(() => stdoutCallback(Buffer.from('test output'))).not.toThrow();
    expect(() => stderrCallback(Buffer.from('test error'))).not.toThrow();
  });
});
