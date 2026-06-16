import { createConnection, Socket } from 'node:net';
import { getIpcSocketPath } from '../shared/paths';
import type { IpcRequest, IpcPushEvent } from '../shared/types';

export class ElectronIpcClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private pushListeners = new Set<(event: IpcPushEvent) => void>();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(getIpcSocketPath(), () => {
        resolve();
      });
      this.socket.on('data', (data) => this.handleData(data));
      this.socket.on('error', reject);
      this.socket.on('close', () => {
        this.socket = null;
      });
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  invoke(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('IPC 未连接'));
        return;
      }
      const id = `${Date.now()}-${Math.random()}`;
      const request: IpcRequest = { id, method, params };
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify(request) + '\n');
    });
  }

  onPush(listener: (event: IpcPushEvent) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString('utf-8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if ('id' in msg) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error.message));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if (msg.type === 'push') {
          for (const listener of this.pushListeners) {
            listener(msg as IpcPushEvent);
          }
        }
      } catch {
        // ignore invalid lines
      }
    }
  }
}
