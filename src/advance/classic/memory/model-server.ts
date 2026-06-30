import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { logger } from '../../../core/logger.js';
import { getLogDir } from '../../../core/platform.js';
import type { ModelServiceStatus } from '../../../electron/shared/service-status.js';

export type ModelCapability = 'embedding' | 'rerank';

const MAX_LOG_LINES = 2000;
const LOG_TAIL_LINES = 100;

export interface ModelServerOptions {
  capability: ModelCapability;
  model: string;
  venvDir: string;
  /** 状态变化回调，用于本地模型管理器实时聚合状态 */
  onStatusChange?: (status: ModelServiceStatus) => void;
  /** 启动超时（毫秒），默认 10 分钟 */
  startupTimeoutMs?: number;
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

function getHubCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  return join(homedir(), '.cache', 'huggingface', 'hub');
}

function getModelCacheDir(modelId: string): string {
  const safeId = modelId.replace(/\//g, '--');
  return join(getHubCacheDir(), `models--${safeId}`);
}

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
}

async function fetchTreeSize(modelId: string, path = ''): Promise<number | null> {
  const url = `https://huggingface.co/api/models/${modelId}/tree/main${path ? `/${path}` : ''}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const entries = (await res.json()) as TreeEntry[];
    let total = 0;
    for (const entry of entries) {
      if (entry.type === 'file' || entry.type === 'blob') {
        total += entry.size ?? 0;
      } else if (entry.type === 'directory') {
        const sub = await fetchTreeSize(modelId, entry.path);
        if (sub != null) total += sub;
      }
    }
    return total;
  } catch {
    return null;
  }
}

function getDownloadedBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let bytes = 0;
  const walk = (root: string) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          bytes += statSync(fullPath).size;
        } catch {
          // 忽略并发读写导致的 stat 失败
        }
      }
    }
  };
  walk(dir);
  return bytes;
}

export class ModelServer {
  private process: ChildProcess | null = null;
  private started = false;
  private urlValue: string | null = null;
  private exitHandler?: () => void;
  private statusValue: ModelServiceStatus = { state: 'idle', url: null, error: null, progress: null };
  private stderrBuffer = '';
  private progressTimer: NodeJS.Timeout | null = null;
  private expectedTotalBytes: number | null = null;
  private lastProgress: number | null = null;
  private logLines: string[] = [];
  private logFilePath: string | null = null;

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

  getLogs(maxLines = MAX_LOG_LINES): string[] {
    return this.logLines.slice(-maxLines);
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
    const cli = join(
      this.options.venvDir,
      process.platform === 'win32' ? 'Scripts\\infinity_emb.exe' : 'bin/infinity_emb'
    );
    const args = [
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
      const child = spawn(cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DO_NOT_TRACK: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          INFINITY_NO_BETTERTRANSFORMER: '1',
          // 强制 tqdm 在非 TTY（pipe）环境下也输出进度条，且每行一个新百分比，便于解析
          TQDM_POSITION: '-1',
          PYTHONUNBUFFERED: '1',
        },
      });
      this.process = child;
      if (this.exitHandler) {
        child.on('exit', this.exitHandler);
      }
      this.initLogStream();

      this.startProgressTracking(this.options.model);

      // 同时累积 stdout 与 stderr，infinity_emb v2 会把 Uvicorn running 输出到 stderr
      let output = '';

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        this.appendLog('stdout', text);
        output += text;
        this.inferStateFromLog(text);
        this.tryParseUrl(output, resolve);
      });

      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        this.appendLog('stderr', text);
        this.stderrBuffer += text;
        output += text;
        this.inferStateFromLog(text);
        this.tryParseUrl(output, resolve);
      });

      child.on('error', (err) => {
        this.setError(`启动 ${this.options.capability} 失败: ${err.message}`);
        this.cleanup();
        reject(new Error(`启动 ${this.options.capability} 失败: ${err.message}`));
      });

      child.on('exit', (code) => {
        const tail = this.getLogs(LOG_TAIL_LINES).join('\n');
        if (!this.started) {
          this.setError(`${this.options.capability} 进程退出 code=${code}\n最近日志:\n${tail}`);
        }
        const stderrSnapshot = this.stderrBuffer;
        this.cleanup();
        if (!this.started) {
          reject(new Error(`${this.options.capability} 进程退出 code=${code}, output=${output}, stderr=${stderrSnapshot}`));
        }
      });

      setTimeout(() => {
        if (!this.started) {
          const tail = this.getLogs(LOG_TAIL_LINES).join('\n');
          const message = `${this.options.capability} 启动超时\n最近日志:\n${tail}`;
          this.setError(message);
          this.stop();
          reject(new Error(message));
        }
      }, this.options.startupTimeoutMs ?? 600000);
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
    this.stopProgressTracking();
    this.logFilePath = null;
    this.logLines = [];
    this.process = null;
    this.started = false;
    this.urlValue = null;
    this.stderrBuffer = '';
  }

  private initLogStream(): void {
    try {
      const logDir = getLogDir();
      mkdirSync(logDir, { recursive: true });
      this.logFilePath = join(logDir, `model-${this.options.capability}-${Date.now()}.log`);
    } catch (err) {
      logger.warn({ err, capability: this.options.capability }, '创建模型日志文件失败');
      this.logFilePath = null;
    }
  }

  private appendLog(source: 'stdout' | 'stderr', text: string): void {
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const tagged = `[${source}] ${line}`;
      this.logLines.push(tagged);
      if (this.logLines.length > MAX_LOG_LINES) {
        this.logLines.shift();
      }
      logger.debug({ capability: this.options.capability, source, line }, '模型进程日志');
      if (this.logFilePath) {
        try {
          appendFileSync(this.logFilePath, `${tagged}\n`);
        } catch (err) {
          logger.warn({ err, capability: this.options.capability }, '写入模型日志文件失败');
        }
      }
    }
  }

  private startProgressTracking(modelId: string): void {
    this.stopProgressTracking();
    this.expectedTotalBytes = null;
    this.lastProgress = null;

    // 先异步获取模型总大小，再开始轮询缓存目录
    fetchTreeSize(modelId)
      .then((total) => {
        if (total != null && total > 0) {
          this.expectedTotalBytes = total;
          logger.debug({ modelId, totalBytes: total }, '已获取 HuggingFace 模型总大小');
        }
      })
      .catch(() => {
        // 获取失败则退化为只显示下载状态，不显示百分比
      })
      .finally(() => {
        if (this.started || this.statusValue.state === 'error') return;
        const cacheDir = getModelCacheDir(modelId);
        this.progressTimer = setInterval(() => {
          if (this.started || this.statusValue.state === 'error') {
            this.stopProgressTracking();
            return;
          }
          const downloaded = getDownloadedBytes(cacheDir);
          if (this.expectedTotalBytes && this.expectedTotalBytes > 0) {
            const ratio = downloaded / this.expectedTotalBytes;
            const progress = Math.min(99, Math.round(ratio * 100));
            if (this.lastProgress == null || progress > this.lastProgress) {
              this.lastProgress = progress;
              this.setStatus('downloading', progress);
            }
          }
        }, 1000);
      });
  }

  private stopProgressTracking(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
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
      this.stopProgressTracking();
      this.statusValue = { state: 'running', url: this.urlValue, error: null, progress: null };
      this.options.onStatusChange?.(this.getStatus());
      resolve(this.urlValue);
    }
  }

  private inferStateFromLog(text: string): void {
    if (this.started) return;

    // 优先从百分比进度条提取最大进度值（支持 45%、45.5%）
    const percentMatches = text.match(/(\d+(?:\.\d+)?)%/g);
    if (percentMatches) {
      const maxProgress = Math.max(...percentMatches.map((m) => parseFloat(m)));
      this.setStatus('downloading', Math.round(maxProgress));
      return;
    }

    // 没有百分比但出现 downloading 关键字时，保持下载状态（进度未知）
    if (/downloading/i.test(text)) {
      this.setStatus('downloading', null);
      return;
    }

    // 模型加载阶段的关键字
    if (/warmup|loading|loading checkpoint|load pretrained/i.test(text)) {
      this.setStatus('loading');
    }
  }
}
