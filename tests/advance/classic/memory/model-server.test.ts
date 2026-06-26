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

  it('启动时禁用 bettertransformer 并设置对应环境变量', async () => {
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

    const [, , options] = vi.mocked(spawn).mock.calls[0];
    expect(options?.env).toMatchObject({ INFINITY_BETTERTRANSFORMER: 'false' });
  });
});
