import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { IpcServer } from '../../../src/advance/ipc/server';

function sendAndReceive(socketPath: string, msg: object | string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
      client.write(line + '\n');
    });
    let buffer = '';
    client.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        resolve(buffer.slice(0, idx));
        client.destroy();
      }
    });
    client.on('error', reject);
  });
}

describe('IpcServer', () => {
  let tmp: string;
  let socketPath: string;
  let server: IpcServer;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-ipc-'));
    socketPath = join(tmp, 'test.sock');
    server = new IpcServer({
      socketPath,
      handler: async (method, params) => {
        if (method === 'echo') return params;
        throw new Error('unknown');
      },
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('应响应 echo 请求', async () => {
    await server.start();
    const res = await sendAndReceive(socketPath, { id: '1', method: 'echo', params: { hello: 'world' } });
    const parsed = JSON.parse(res);
    expect(parsed.id).toBe('1');
    expect(parsed.result).toEqual({ hello: 'world' });
  });

  it('非法 JSON 应返回错误', async () => {
    await server.start();
    const res = await sendAndReceive(socketPath, 'not-json');
    const parsed = JSON.parse(res);
    expect(parsed.error.code).toBe('INVALID_JSON');
  });
});
