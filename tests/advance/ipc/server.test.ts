import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { IpcServer } from '../../../src/advance/ipc/server';

function sendAndReceive(socketPath: string, msg: object | string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
      client.write(line + '\n');
    });
    let buffer = '';
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        client.destroy();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`sendAndReceive 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    client.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1 && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(buffer.slice(0, idx));
        client.destroy();
      }
    });
    client.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    client.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error('连接意外关闭'));
      }
    });
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

  it('handler 抛出异常应返回 HANDLER_ERROR', async () => {
    await server.start();
    const res = await sendAndReceive(socketPath, { id: '2', method: 'bad', params: {} });
    const parsed = JSON.parse(res);
    expect(parsed.id).toBe('2');
    expect(parsed.error.code).toBe('HANDLER_ERROR');
  });

  it('broadcast 推送应被多个客户端收到', async () => {
    await server.start();

    const client1 = createConnection(socketPath);
    const client2 = createConnection(socketPath);

    // 等待两个客户端都连接成功，并给 server 一点时间来记录 socket
    await Promise.all([
      new Promise<void>((resolve) => client1.on('connect', resolve)),
      new Promise<void>((resolve) => client2.on('connect', resolve)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const recv1 = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client1 超时')), 3000);
      let buf = '';
      client1.on('data', (data) => {
        buf += data.toString();
        if (buf.includes('\n')) {
          clearTimeout(timer);
          resolve(buf.trim());
        }
      });
    });

    const recv2 = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client2 超时')), 3000);
      let buf = '';
      client2.on('data', (data) => {
        buf += data.toString();
        if (buf.includes('\n')) {
          clearTimeout(timer);
          resolve(buf.trim());
        }
      });
    });

    server.broadcast('test-event', { foo: 'bar' });

    const [msg1, msg2] = await Promise.all([recv1, recv2]);
    const parsed1 = JSON.parse(msg1);
    const parsed2 = JSON.parse(msg2);
    expect(parsed1.type).toBe('push');
    expect(parsed1.event).toBe('test-event');
    expect(parsed1.payload).toEqual({ foo: 'bar' });
    expect(parsed2.type).toBe('push');

    client1.destroy();
    client2.destroy();
  });

  it('同一 socket 连续发送多条消息应分别响应', async () => {
    await server.start();
    const res = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超时')), 5000);
      const client = createConnection(socketPath, () => {
        client.write(JSON.stringify({ id: 'a', method: 'echo', params: { n: 1 } }) + '\n');
        client.write(JSON.stringify({ id: 'b', method: 'echo', params: { n: 2 } }) + '\n');
      });
      let buf = '';
      let count = 0;
      client.on('data', (data) => {
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          count++;
          if (count === 2) {
            clearTimeout(timer);
            resolve(line); // 返回第二条响应
            client.destroy();
            return;
          }
        }
      });
    });
    const parsed = JSON.parse(res);
    expect(parsed.id).toBe('b');
    expect(parsed.result).toEqual({ n: 2 });
  });

  it('stop 后重新 start 应成功', async () => {
    await server.start();
    await server.stop();
    await server.start();
    const res = await sendAndReceive(socketPath, { id: '3', method: 'echo', params: 'restart' });
    const parsed = JSON.parse(res);
    expect(parsed.id).toBe('3');
    expect(parsed.result).toBe('restart');
  });

  it('一条 data 事件包含多条消息（粘包）应分别处理', async () => {
    await server.start();
    const res = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超时')), 5000);
      const client = createConnection(socketPath, () => {
        // 故意将两条消息合并写入，模拟粘包
        const msg1 = JSON.stringify({ id: 'c', method: 'echo', params: { m: 1 } });
        const msg2 = JSON.stringify({ id: 'd', method: 'echo', params: { m: 2 } });
        client.write(msg1 + '\n' + msg2 + '\n');
      });
      let buf = '';
      let count = 0;
      client.on('data', (data) => {
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          count++;
          if (count === 2) {
            clearTimeout(timer);
            resolve(line); // 返回第二条响应
            client.destroy();
            return;
          }
        }
      });
    });
    const parsed = JSON.parse(res);
    expect(parsed.id).toBe('d');
    expect(parsed.result).toEqual({ m: 2 });
  });

  it('缺少 id 或 method 的请求应返回 INVALID_REQUEST', async () => {
    await server.start();
    const res = await sendAndReceive(socketPath, { method: 'echo' });
    const parsed = JSON.parse(res);
    expect(parsed.error.code).toBe('INVALID_REQUEST');
  });
});
