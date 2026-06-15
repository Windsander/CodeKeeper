import { createServer, Server, Socket } from 'node:net';
import { unlinkSync, existsSync, chmodSync } from 'node:fs';
import { logger } from '../../core/logger';
import type { IpcRequest, IpcResponse, IpcPushEvent } from './types';

export interface IpcServerOptions {
  socketPath: string;
  handler: (method: string, params: unknown) => Promise<unknown>;
}

export class IpcServer {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  constructor(private options: IpcServerOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (existsSync(this.options.socketPath)) {
        try {
          unlinkSync(this.options.socketPath);
        } catch (err) {
          logger.warn({ err, path: this.options.socketPath }, '清理旧 socket 失败');
        }
      }

      this.server = createServer((socket) => {
        this.sockets.add(socket);
        let buffer = '';
        socket.on('data', (data) => {
          buffer += data.toString('utf-8');
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) this.handleLine(socket, line);
          }
        });
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', (err) => logger.warn({ err }, 'IPC socket 错误'));
      });

      this.server.listen(this.options.socketPath, () => {
        try {
          chmodSync(this.options.socketPath, 0o600);
        } catch {
          // Windows 不支持 chmod
        }
        logger.info({ path: this.options.socketPath }, 'IPC server 已启动');
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const socket of this.sockets) {
        socket.destroy();
      }
      this.sockets.clear();
      this.server?.close(() => {
        try {
          if (existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
        } catch {
          // ignore
        }
        resolve();
      });
    });
  }

  broadcast(event: string, payload: unknown): void {
    const msg: IpcPushEvent = { type: 'push', event, payload };
    const line = JSON.stringify(msg) + '\n';
    for (const socket of this.sockets) {
      socket.write(line);
    }
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: IpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      this.send(socket, { id: 'unknown', error: { code: 'INVALID_JSON', message: '非法 JSON' } });
      return;
    }

    try {
      const result = await this.options.handler(request.method, request.params ?? {});
      this.send(socket, { id: request.id, result });
    } catch (err) {
      this.send(socket, {
        id: request.id,
        error: {
          code: 'HANDLER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private send(socket: Socket, response: IpcResponse): void {
    socket.write(JSON.stringify(response) + '\n');
  }
}
