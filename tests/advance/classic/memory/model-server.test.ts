/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ModelServer } from '../../../../src/advance/classic/memory/model-server.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

async function waitForSpawnCall(): Promise<void> {
  const start = Date.now();
  while (vi.mocked(spawn).mock.calls.length === 0) {
    if (Date.now() - start > 1000) {
      throw new Error('等待 spawn 调用超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('ModelServer', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('启动后解析 stdout 中的 URL', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const server = new ModelServer({
      capability: 'embedding',
      model: 'intfloat/multilingual-e5-small',
      venvDir: '/venv',
    });

    const startPromise = server.start();
    await waitForSpawnCall();
    fake.stdout.emit('data', Buffer.from('Uvicorn running on http://127.0.0.1:12345'));

    const url = await startPromise;
    expect(url).toBe('http://127.0.0.1:12345');
    expect(server.isHealthy()).toBe(true);
  });

  it('启动时禁用 bettertransformer 并设置对应环境变量与 CLI 参数', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const server = new ModelServer({
      capability: 'embedding',
      model: 'intfloat/multilingual-e5-small',
      venvDir: '/venv',
    });

    const startPromise = server.start();
    await waitForSpawnCall();
    fake.stdout.emit('data', Buffer.from('Uvicorn running on http://127.0.0.1:12345'));
    await startPromise;

    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(options?.env).toMatchObject({ INFINITY_NO_BETTERTRANSFORMER: '1' });
    expect(args).toContain('--host');
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('--engine');
    expect(args).toContain('torch');
    expect(args).toContain('--no-bettertransformer');
  });

  it('stderr 出现下载进度时状态变为 downloading', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const server = new ModelServer({
      capability: 'embedding',
      model: 'intfloat/multilingual-e5-small',
      venvDir: '/venv',
    });

    const startPromise = server.start();
    await waitForSpawnCall();

    expect(server.getStatus().state).toBe('starting');

    fake.stderr.emit('data', Buffer.from('Downloading model... 45%'));
    expect(server.getStatus().state).toBe('downloading');

    fake.stdout.emit('data', Buffer.from('Uvicorn running on http://127.0.0.1:12345'));
    await startPromise;

    expect(server.getStatus().state).toBe('running');
    expect(server.getStatus().url).toBe('http://127.0.0.1:12345');
  });

  it('stderr 出现 warmup 时状态变为 loading', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const server = new ModelServer({
      capability: 'rerank',
      model: 'Xenova/ms-marco-MiniLM-L-6-v2',
      venvDir: '/venv',
    });

    const startPromise = server.start();
    await waitForSpawnCall();

    fake.stderr.emit('data', Buffer.from('warmup forward pass'));
    expect(server.getStatus().state).toBe('loading');

    fake.stdout.emit('data', Buffer.from('Uvicorn running on http://127.0.0.1:54321'));
    await startPromise;

    expect(server.getStatus().state).toBe('running');
  });

  it('downloading 状态携带进度并触发 onStatusChange', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const onStatusChange = vi.fn();
    const server = new ModelServer({
      capability: 'embedding',
      model: 'intfloat/multilingual-e5-small',
      venvDir: '/venv',
      onStatusChange,
    });

    const startPromise = server.start();
    await waitForSpawnCall();

    fake.stderr.emit('data', Buffer.from('Downloading model.safetensors:  45%|███▌| 45M/100M'));
    expect(server.getStatus().state).toBe('downloading');
    expect(server.getStatus().progress).toBe(45);
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'downloading', progress: 45 })
    );

    fake.stdout.emit('data', Buffer.from('Uvicorn running on http://127.0.0.1:12345'));
    await startPromise;

    expect(server.getStatus().state).toBe('running');
    expect(server.getStatus().progress).toBeNull();
  });

  it('stdout 出现下载进度时状态变为 downloading', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const server = new ModelServer({
      capability: 'embedding',
      model: 'intfloat/multilingual-e5-small',
      venvDir: '/venv',
    });

    const startPromise = server.start();
    await waitForSpawnCall();

    fake.stdout.emit('data', Buffer.from('Downloading model.safetensors:  62%|██████▏| 62M/100M'));
    expect(server.getStatus().state).toBe('downloading');
    expect(server.getStatus().progress).toBe(62);

    fake.stdout.emit('data', Buffer.from('Uvicorn running on http://127.0.0.1:12345'));
    await startPromise;

    expect(server.getStatus().state).toBe('running');
  });

  it('进程异常退出时状态变为 error 并记录 stderr 摘要', async () => {
    const fake = new EventEmitter() as ChildProcess;
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);

    const server = new ModelServer({
      capability: 'embedding',
      model: 'intfloat/multilingual-e5-small',
      venvDir: '/venv',
    });

    const startPromise = server.start();
    await waitForSpawnCall();

    fake.stderr.emit('data', Buffer.from('CUDA out of memory'));
    fake.emit('exit', 1);

    await expect(startPromise).rejects.toThrow('embedding 进程退出');
    expect(server.getStatus().state).toBe('error');
    expect(server.getStatus().error).toContain('CUDA out of memory');
  });
});
