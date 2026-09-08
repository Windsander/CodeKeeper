import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// mock child_process.fork：用 EventEmitter 模拟子进程 IPC 协议。
// replyMode 在 send 时读取，readyMode 在 fork 时读取，
// 测试可在派发前设定子进程行为，避免时序竞争。
let replyMode: 'done' | 'error' | 'hang' = 'done';
let readyMode: 'ready' | 'never' | 'crash' = 'ready';
const forkedChildren: FakeChild[] = [];

class FakeChild extends EventEmitter {
  sent: unknown[] = [];
  killed: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send(message: unknown, callback?: (error: Error | null) => void) {
    this.sent.push(message);
    callback?.(null);
    if (replyMode === 'done') {
      queueMicrotask(() => this.emit('message', { type: 'done' }));
    } else if (replyMode === 'error') {
      queueMicrotask(() => this.emit('message', { type: 'error', message: '执行炸了' }));
    }
    // hang：不回复，模拟长任务
  }
  kill(signal?: string) {
    this.killed = signal ?? null;
    return true;
  }
}

vi.mock('node:child_process', () => {
  const forkFn = () => {
    const child = new FakeChild();
    forkedChildren.push(child);
    if (readyMode === 'ready') {
      // 模拟子进程就绪
      queueMicrotask(() => child.emit('message', { type: 'ready' }));
    } else if (readyMode === 'crash') {
      // 模拟启动即崩
      queueMicrotask(() => child.emit('exit', 1));
    }
    // never：永不 ready
    return child;
  };
  return { fork: forkFn, default: { fork: forkFn } };
});

import { RoleNodeRuntime } from '../../../src/advance/classic/role-node-runtime.js';
import type { Project } from '../../../src/advance/types.js';

const project = { id: 'proj-1', name: '演示', rootPath: '/virtual/demo' } as Project;

function makeRuntime(): RoleNodeRuntime {
  return new RoleNodeRuntime({
    runnerPath: 'virtual-runner.js',
    getDbPath: () => ':memory:',
    getDaemonConfig: () => ({}),
    getMcpUrl: () => 'http://127.0.0.1:1',
    getCodeGraphUrl: () => 'http://127.0.0.1:2',
    readyTimeoutMs: 50,
  });
}

describe('RoleNodeRuntime', () => {
  beforeEach(() => {
    forkedChildren.length = 0;
    replyMode = 'done';
    readyMode = 'ready';
  });

  it('ready 超时：终止子进程并清表，下次触发可重建', async () => {
    readyMode = 'never';
    const runtime = makeRuntime();
    await expect(runtime.runOnce(project, 'reviewer')).rejects.toThrow('等待 ready 超时');
    expect(forkedChildren[0].killed).toBe('SIGKILL');

    // 实例已清表：下次触发重新 fork
    readyMode = 'ready';
    await runtime.runOnce(project, 'reviewer');
    expect(forkedChildren).toHaveLength(2);
  });

  it('启动即崩：ready 前 exit 立即报错，不干等超时', async () => {
    readyMode = 'crash';
    const runtime = makeRuntime();
    await expect(runtime.runOnce(project, 'reviewer')).rejects.toThrow('ready 前退出');
  });

  it('首次触发 fork 子进程并等待 ready 后派发 run', async () => {
    const runtime = makeRuntime();
    await runtime.runOnce(project, 'reviewer');

    expect(forkedChildren).toHaveLength(1);
    expect(forkedChildren[0].sent).toEqual([{ type: 'run' }]);
  });

  it('同一节点实例复用子进程', async () => {
    const runtime = makeRuntime();
    await runtime.runOnce(project, 'reviewer');
    await runtime.runOnce(project, 'reviewer');
    expect(forkedChildren).toHaveLength(1);
    expect(forkedChildren[0].sent).toHaveLength(2);
  });

  it('子进程执行中重入触发被跳过', async () => {
    replyMode = 'hang';
    const runtime = makeRuntime();

    const first = runtime.runOnce(project, 'reviewer');
    // 等第一条 run 指令送达
    await vi.waitFor(() => {
      const sent = forkedChildren[0]?.sent ?? [];
      if (sent.length === 0) throw new Error('等待 run 派发');
    });

    // 执行中再次触发：应立即返回（跳过），且不派发第二条 run
    await runtime.runOnce(project, 'reviewer');
    expect(forkedChildren[0].sent).toHaveLength(1);

    // 手动完成第一次执行，清理挂起
    forkedChildren[0].emit('message', { type: 'done' });
    await first;
  });

  it('子进程返回 error 时 runOnce 抛出', async () => {
    replyMode = 'error';
    const runtime = makeRuntime();
    await expect(runtime.runOnce(project, 'reviewer')).rejects.toThrow('执行炸了');
  });

  it('stopInstance / stopRole / stopAll 终止对应子进程', async () => {
    const runtime = makeRuntime();
    await runtime.runOnce(project, 'reviewer');
    await runtime.runOnce(project, 'maintainer');

    runtime.stopInstance('proj-1', 'reviewer');
    expect(forkedChildren[0].killed).toBe('SIGTERM');
    expect(forkedChildren[1].killed).toBeNull();

    runtime.stopRole('maintainer');
    expect(forkedChildren[1].killed).toBe('SIGTERM');

    await runtime.runOnce(project, 'reviewer');
    runtime.stopAll();
    for (const child of forkedChildren) {
      expect(child.killed).toBe('SIGTERM');
    }
  });
});
