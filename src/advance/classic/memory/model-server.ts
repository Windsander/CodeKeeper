import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { logger } from '../../../core/logger.js';

export type ModelCapability = 'embedding' | 'rerank';

export interface ModelServerOptions {
  capability: ModelCapability;
  model: string;
  venvDir: string;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export class ModelServer {
  private process: ChildProcess | null = null;
  private started = false;
  private urlValue: string | null = null;
  private exitHandler?: () => void;

  constructor(private readonly options: ModelServerOptions) {}

  get url(): string | null {
    return this.urlValue;
  }

  isHealthy(): boolean {
    return this.started && this.process !== null && !this.process.killed;
  }

  onExit(handler: () => void): void {
    this.exitHandler = handler;
    this.process?.on('exit', handler);
  }

  async start(): Promise<string> {
    if (this.process) {
      return this.urlValue!;
    }

    const port = await getFreePort();
    const python = join(this.options.venvDir, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
    const args = [
      '-m',
      'infinity_emb',
      'v2',
      '--model-id',
      this.options.model,
      '--port',
      String(port),
      '--url-prefix',
      '/v1',
    ];

    logger.info({ model: this.options.model, port }, `启动 ${this.options.capability} 本地模型服务`);

    return new Promise((resolve, reject) => {
      const child = spawn(python, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DO_NOT_TRACK: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          INFINITY_BETTERTRANSFORMER: 'false',
        },
      });
      this.process = child;
      if (this.exitHandler) {
        child.on('exit', this.exitHandler);
      }

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
        this.tryParseUrl(stdout, resolve);
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        this.cleanup();
        reject(new Error(`启动 ${this.options.capability} 失败: ${err.message}`));
      });

      child.on('exit', (code) => {
        this.cleanup();
        if (!this.started) {
          reject(new Error(`${this.options.capability} 进程退出 code=${code}, stdout=${stdout}, stderr=${stderr}`));
        }
      });

      setTimeout(() => {
        if (!this.started) {
          this.stop();
          reject(new Error(`${this.options.capability} 启动超时`));
        }
      }, 120000);
    });
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    const proc = this.process;
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
    this.cleanup();
  }

  private cleanup(): void {
    this.process = null;
    this.started = false;
    this.urlValue = null;
  }

  private tryParseUrl(stdout: string, resolve: (url: string) => void): void {
    if (this.started) return;
    const match = stdout.match(/(https?:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      this.urlValue = match[1];
      this.started = true;
      resolve(this.urlValue);
    }
  }
}
