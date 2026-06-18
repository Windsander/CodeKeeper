/**
 * ClassicService 单元测试
 *
 * 通过 options.spawn 注入 mock spawn 函数，验证子进程生命周期管理。
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ClassicService } from '../../../src/advance/classic/classic-service';
import type { MetadataStore } from '../../../src/advance/store/metadata-store';
import type { ProjectRegistry } from '../../../src/advance/project-registry';

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

  it('start 应调用 spawn 并传入 mr-agent-entry.js 路径', () => {
    const options = makeMockOptions({ spawn: spawnMock });
    const service = new ClassicService(options);

    service.start();

    expect(spawnMock).toHaveBeenCalledOnce();
    const [command, args, spawnOptions] = spawnMock.mock.calls[0];
    expect(command).toBe('node');
    expect(args[0]).toContain('mr-agent-entry.js');
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(spawnOptions.env).toBeDefined();
  });

  it('start 在已运行时不应重复 spawn', () => {
    const options = makeMockOptions({ spawn: spawnMock });
    const service = new ClassicService(options);

    service.start();
    service.start();

    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('stop 应调用 kill 并清除 child 引用', () => {
    const options = makeMockOptions({ spawn: spawnMock });
    const service = new ClassicService(options);

    service.start();
    expect(service.isRunning()).toBe(true);

    service.stop();

    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
    expect(service.isRunning()).toBe(false);
  });

  it('stop 在未运行时不应报错', () => {
    const options = makeMockOptions({ spawn: spawnMock });
    const service = new ClassicService(options);

    expect(() => service.stop()).not.toThrow();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('restart 应先 stop 再 start', () => {
    const options = makeMockOptions({ spawn: spawnMock });
    const service = new ClassicService(options);

    service.start();
    expect(spawnMock).toHaveBeenCalledOnce();

    service.restart();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
  });

  it('isRunning 在子进程退出后应返回 false', () => {
    const options = makeMockOptions({ spawn: spawnMock });
    const service = new ClassicService(options);

    service.start();
    expect(service.isRunning()).toBe(true);

    const exitCallback = mockOn.mock.calls.find(
      (call) => call[0] === 'exit'
    )?.[1];
    expect(exitCallback).toBeDefined();

    exitCallback(0);
    expect(service.isRunning()).toBe(false);
  });

  it('start 应通过 buildMrAgentEnv 构造环境变量', () => {
    const options = makeMockOptions({
      spawn: spawnMock,
      registryList: vi.fn(() => [
        {
          id: 'p1',
          rootPath: '/path/p1',
          name: 'project-1',
          registeredAt: Date.now(),
          lastScannedAt: null,
          gitlab: { baseUrl: 'https://git.example.com', projectPath: 'group/p1', token: 'token1' },
          mrReview: { enabled: true, autoMergeMode: 'audit', reviewSchedule: '0 9 * * 1-5', learningEnabled: false, maxAutoMergeRisk: 'MEDIUM' },
        },
      ]),
    });

    const service = new ClassicService(options);
    service.start();

    const [, , spawnOptions] = spawnMock.mock.calls[0];
    expect(spawnOptions.env.CK_LLM_API_KEY).toBe('test-key');
    expect(spawnOptions.env.CK_LLM_PROVIDER).toBe('anthropic');
    expect(spawnOptions.env.CK_LLM_MODEL).toBe('claude-3-5-sonnet');
    expect(spawnOptions.env.CK_PROJECTS_JSON).toBeDefined();

    const projects = JSON.parse(spawnOptions.env.CK_PROJECTS_JSON);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('project-1');
  });

  it('子进程 stdout/stderr 数据应被转发到 logger', () => {
    const options = makeMockOptions({ spawn: spawnMock });
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
