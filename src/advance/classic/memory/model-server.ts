import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { logger } from '../../../core/logger.js';
import type { ModelServiceStatus } from '../../../electron/shared/service-status.js';

export type ModelCapability = 'embedding' | 'rerank';

export interface ModelServerOptions {
  capability: ModelCapability;
  model: string;
  venvDir: string;
  /** 状态变化回调，用于本地模型管理器实时聚合状态 */
  onStatusChange?: (status: ModelServiceStatus) => void;
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
  private statusValue: ModelServiceStatus = { state: 'idle', url: null, error: null, progress: null };
  private stderrBuffer = '';

  constructor(private readonly options: ModelServerOptions) {}

  get url(): string | null {
    return this.urlValue;
  }

  getStatus(): ModelServiceStatus {
    return { ...this.statusValue };
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
      '--host',
      '127.0.0.1',
      '--url-prefix',
      '/v1',
      '--engine',
      'torch',
      '--no-bettertransformer',
    ];

    this.setStatus('starting');
    logger.info({ model: this.options.model, port }, `启动 ${this.options.capability} 本地模型服务`);

    return new Promise((resolve, reject) => {
      const child = spawn(python, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DO_NOT_TRACK: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          INFINITY_NO_BETTERTRANSFORMER: '1',
        },
      });
      this.process = child;
      if (this.exitHandler) {
        child.on('exit', this.exitHandler);
      }

      let stdout = '';

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        this.inferStateFromLog(text);
        this.tryParseUrl(stdout, resolve);
      });

      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        this.stderrBuffer += text;
        this.inferStateFromLog(text);
      });

      child.on('error', (err) => {
        this.setError(`启动 ${this.options.capability} 失败: ${err.message}`);
        this.cleanup();
        reject(new Error(`启动 ${this.options.capability} 失败: ${err.message}`));
      });

      child.on('exit', (code) => {
        if (!this.started) {
          const tail = this.stderrBuffer.slice(-500);
          this.setError(`${this.options.capability} 进程退出 code=${code}，stderr=${tail}`);
        }
        this.cleanup();
        if (!this.started) {
          reject(new Error(`${this.options.capability} 进程退出 code=${code}, stdout=${stdout}, stderr=${this.stderrBuffer}`));
        }
      });

      setTimeout(() => {
        if (!this.started) {
          this.setError(`${this.options.capability} 启动超时`);
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
    this.setStatus('idle');
  }

  private cleanup(): void {
    this.process = null;
    this.started = false;
    this.urlValue = null;
    this.stderrBuffer = '';
  }

  private setStatus(state: ModelServiceStatus['state'], progress?: number | null): void {
    // running / error 状态为终态，避免被后续 stderr 日志覆盖
    if (this.statusValue.state === 'running' || this.statusValue.state === 'error') {
      return;
    }
    this.statusValue = { state, url: this.urlValue, error: null, progress: progress ?? null };
    this.options.onStatusChange?.(this.getStatus());
  }

  private setError(message: string): void {
    this.statusValue = { state: 'error', url: this.urlValue, error: message, progress: null };
    this.options.onStatusChange?.(this.getStatus());
  }

  private tryParseUrl(stdout: string, resolve: (url: string) => void): void {
    if (this.started) return;
    const match = stdout.match(/(https?:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      this.urlValue = match[1];
      this.started = true;
      this.statusValue = { state: 'running', url: this.urlValue, error: null, progress: null };
      this.options.onStatusChange?.(this.getStatus());
      resolve(this.urlValue);
    }
  }

  private inferStateFromLog(text: string): void {
    if (this.started) return;
    // infinity_emb 下载模型时 stdout/stderr 会输出 Downloading ... 45% 这类进度
    if (/downloading/i.test(text) || /\d+%/.test(text)) {
      const match = text.match(/(\d{1,3})%/);
      this.setStatus('downloading', match ? parseInt(match[1], 10) : null);
      return;
    }
    // 模型加载阶段的关键字
    if (/warmup|loading|loading checkpoint/i.test(text)) {
      this.setStatus('loading');
    }
  }
}
