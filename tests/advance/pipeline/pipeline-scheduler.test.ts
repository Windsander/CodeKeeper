import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

// mock node-cron：捕获注册的表达式与回调，手动触发
const cronJobs = new Map<string, () => void>();
vi.mock('node-cron', () => ({
  validate: () => true,
  schedule: (expr: string, cb: () => void) => {
    cronJobs.set(expr, cb);
    return { stop: vi.fn(() => cronJobs.delete(expr)) };
  },
}));

// mock RoleNodeRuntime：不真的 fork 子进程
const runOnceSpy = vi.fn().mockResolvedValue(undefined);
const stopRoleSpy = vi.fn();
const stopInstanceSpy = vi.fn();
const stopProjectSpy = vi.fn();
const stopAllSpy = vi.fn();
vi.mock('../../../src/advance/classic/role-node-runtime.js', () => ({
  RoleNodeRuntime: class {
    runOnce = runOnceSpy;
    stopRole = stopRoleSpy;
    stopInstance = stopInstanceSpy;
    stopProject = stopProjectSpy;
    stopAll = stopAllSpy;
    countInstances = () => 0;
  },
}));

import { PipelineScheduler } from '../../../src/advance/pipeline/pipeline-scheduler.js';
import type { Project } from '../../../src/advance/types.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../src/advance/store/schema.sql'), 'utf-8'));
  return db;
}

function makeProject(rootPath: string, roles: Project['roles']): Project {
  return { id: 'proj-1', name: '演示', rootPath, roles } as Project;
}

function makeContext(project: Project) {
  const db = makeDb();
  return {
    store: {
      listProjects: () => [project],
      getProject: (id: string) => (id === project.id ? project : null),
      getRoleEnabledProjects: (role: string) =>
        (project.roles as Record<
          string,
          { enabled?: boolean; automation?: { enabled: boolean } }
        >) && (project.roles as Record<string, { enabled?: boolean }>)[role]?.enabled
          ? [project]
          : [],
      database: db,
    },
    dbPath: ':memory:',
    getDaemonConfig: () => ({
      apiKey: 'test-key',
      apiUrl: 'https://llm.example.invalid',
      provider: 'openai',
      model: 'test-model',
      headers: '{}',
      scanCron: '',
      llmRequestsPerMinute: 10,
      everos: '',
    }),
  };
}

describe('PipelineScheduler', () => {
  let tmp: string;

  beforeEach(() => {
    cronJobs.clear();
    runOnceSpy.mockClear();
    stopRoleSpy.mockClear();
    stopInstanceSpy.mockClear();
    stopProjectSpy.mockClear();
    stopAllSpy.mockClear();
    tmp = mkdtempSync(join(tmpdir(), 'ck-scheduler-'));
    return () => rmSync(tmp, { recursive: true, force: true });
  });

  function enabledRole(role: 'reviewer' | 'maintainer', schedule?: string) {
    return { role, enabled: true, reviewSchedule: schedule };
  }

  it('start 后为启用项目注册 cron 触发器，触发后经 runtime 执行对应角色', async () => {
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');

    await scheduler.start('reviewer');

    // 默认管线已生成，trigger.cron 注册为项目角色配置的调度
    expect(cronJobs.has('*/7 * * * *')).toBe(true);
    // start 会立即执行一轮（对拍旧版 startProjectLoop 行为）
    await vi.waitFor(() => expect(runOnceSpy).toHaveBeenCalled());
    expect(runOnceSpy.mock.calls[0][0].id).toBe('proj-1');
    expect(runOnceSpy.mock.calls[0][1]).toBe('reviewer');

    // 手动触发 cron 回调再执行一轮
    runOnceSpy.mockClear();
    cronJobs.get('*/7 * * * *')!();
    await vi.waitFor(() => expect(runOnceSpy).toHaveBeenCalled());
  });

  it('多角色管线：触发 reviewer 不会执行 maintainer（下游子图隔离）', async () => {
    cronJobs.clear();
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
      maintainer: enabledRole('maintainer', '*/9 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');
    scheduler.register('maintainer');
    await scheduler.start('reviewer');
    await scheduler.start('maintainer');
    await vi.waitFor(() => runOnceSpy.mock.calls.length >= 2);
    runOnceSpy.mockClear();

    cronJobs.get('*/7 * * * *')!();
    await vi.waitFor(() => expect(runOnceSpy).toHaveBeenCalled());
    for (const call of runOnceSpy.mock.calls) {
      expect(call[1]).toBe('reviewer');
    }
  });

  it('stop 摘除触发器并停止角色实例；getStatus 反映运行态', async () => {
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');

    expect(scheduler.getStatus('reviewer').running).toBe(false);
    await scheduler.start('reviewer');
    expect(scheduler.getStatus('reviewer')).toEqual({
      running: true,
      enabledProjects: 1,
      runningProjects: ['proj-1'],
    });

    await scheduler.stop('reviewer');
    expect(scheduler.getStatus('reviewer').running).toBe(false);
    expect(stopRoleSpy).toHaveBeenCalledWith('reviewer');
  });

  it('restartProject 停止对应节点实例', async () => {
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');
    await scheduler.start('reviewer');

    await scheduler.restartProject('reviewer', 'proj-1');
    expect(stopInstanceSpy).toHaveBeenCalledWith('proj-1', 'reviewer');
  });

  it('未启动的角色不产生触发器', async () => {
    cronJobs.clear();
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');
    scheduler.rescheduleAll();
    expect(cronJobs.size).toBe(0);
  });

  it('reloadProject 重排调度并重启项目节点实例（配置变更感知）', async () => {
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');
    await scheduler.start('reviewer');
    stopProjectSpy.mockClear();

    scheduler.reloadProject('proj-1');
    expect(stopProjectSpy).toHaveBeenCalledWith('proj-1');
    // 重排后触发器仍然存在
    expect(cronJobs.has('*/7 * * * *')).toBe(true);
  });

  it('unloadProject 摘除项目全部触发器并终止实例（注销语义）', async () => {
    const project = makeProject(tmp, {
      reviewer: enabledRole('reviewer', '*/7 * * * *'),
    } as Project['roles']);
    const scheduler = new PipelineScheduler(makeContext(project) as never, 'virtual-runner.js', {
      mcpUrl: 'http://127.0.0.1:1',
      codeGraphUrl: 'http://127.0.0.1:2',
    });
    scheduler.register('reviewer');
    await scheduler.start('reviewer');
    expect(cronJobs.size).toBe(1);

    scheduler.unloadProject('proj-1');
    expect(stopProjectSpy).toHaveBeenCalledWith('proj-1');
    expect(cronJobs.size).toBe(0);
  });
});
