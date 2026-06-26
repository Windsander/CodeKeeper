import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../../../core/logger.js';
import { getAppStorageDir } from '../../../core/platform.js';
import { ModelServer, type ModelCapability } from './model-server.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_RERANK_MODEL,
} from './local-model-catalog.js';

export interface LocalModelServiceManagerOptions {
  venvDir?: string;
  embeddingModel?: string;
  rerankModel?: string;
}

export class LocalModelServiceManager {
  private readonly venvDir: string;
  private readonly embeddingModel: string;
  private readonly rerankModel: string;
  private embeddingServer: ModelServer | null = null;
  private rerankServer: ModelServer | null = null;
  private starting = false;
  private stopping = false;

  constructor(options: LocalModelServiceManagerOptions = {}) {
    this.venvDir = options.venvDir ?? join(getAppStorageDir(), 'local-models-venv');
    this.embeddingModel = options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.rerankModel = options.rerankModel ?? DEFAULT_RERANK_MODEL;
  }

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.stopping = false;
    try {
      await this.ensureVenv();
      await this.startCapability('embedding', this.embeddingModel);
      await this.startCapability('rerank', this.rerankModel);
      logger.info(
        { embeddingUrl: this.getEmbeddingUrl(), rerankUrl: this.getRerankUrl() },
        '本地 Embedding/Rerank 模型服务已启动'
      );
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.stopping = true;
    this.embeddingServer?.stop();
    this.rerankServer?.stop();
    this.embeddingServer = null;
    this.rerankServer = null;
  }

  getEmbeddingUrl(): string | null {
    return this.embeddingServer?.url ?? null;
  }

  getRerankUrl(): string | null {
    return this.rerankServer?.url ?? null;
  }

  async restart(capability: ModelCapability): Promise<void> {
    const server = capability === 'embedding' ? this.embeddingServer : this.rerankServer;
    server?.stop();
    const model = capability === 'embedding' ? this.embeddingModel : this.rerankModel;
    await this.startCapability(capability, model, true);
  }

  private sitePackagesDir(): string {
    if (process.platform === 'win32') {
      return join(this.venvDir, 'Lib', 'site-packages');
    }
    const libDir = join(this.venvDir, 'lib');
    const entries = readdirSync(libDir, { withFileTypes: true });
    const pythonDir = entries.find((e) => e.isDirectory() && e.name.startsWith('python'))?.name;
    if (!pythonDir) {
      throw new Error(`无法定位 venv site-packages: ${libDir}`);
    }
    return join(libDir, pythonDir, 'site-packages');
  }

  private async ensureVenv(): Promise<void> {
    const cli = join(this.venvDir, process.platform === 'win32' ? 'Scripts\\infinity_emb.exe' : 'bin/infinity_emb');
    const stubOk = existsSync(join(this.sitePackagesDir(), 'optimum', 'bettertransformer.py'));
    if (existsSync(cli) && stubOk) return;

    await mkdir(this.venvDir, { recursive: true });
    const python = await this.findPython();
    await this.runCommand(python, ['-m', 'venv', this.venvDir]);
    const pip = join(this.venvDir, process.platform === 'win32' ? 'Scripts\\pip.exe' : 'bin/pip');
    // 使用 [server,torch] 而不是 [optimum]，避免 optimum 2.x 移除 bettertransformer 导致不兼容
    await this.runCommand(pip, ['install', '-U', 'infinity-emb[server,torch]', 'click<8.2']);
    this.ensureOptimumStub();
  }

  /**
   * infinity_emb 0.0.77 依赖 `from optimum.bettertransformer import BetterTransformer`。
   * optimum 2.x 已移除该模块，而完整安装 optimum 在 Python 3.13 下目前无法直接获得 wheel。
   * 这里提供一个最小 stub，让导入不抛异常；同时 ModelServer 启动时通过 `--no-bettertransformer`
   * 禁用 BetterTransformer，实际推理走 torch，不受影响。
   */
  private ensureOptimumStub(): void {
    const sitePackages = this.sitePackagesDir();
    const optimumDir = join(sitePackages, 'optimum');
    if (!existsSync(optimumDir)) {
      mkdirSync(optimumDir, { recursive: true });
    }

    const bettertransformerPath = join(optimumDir, 'bettertransformer.py');
    if (!existsSync(bettertransformerPath)) {
      writeFileSync(
        bettertransformerPath,
        `# 占位 stub：避免 infinity_emb 在 optimum 未安装或 2.x 移除 bettertransformer 时触发 ModuleNotFoundError。
# 实际不会使用 BetterTransformer，因为 ModelServer 启动参数已禁用 bettertransformer。
class BetterTransformerManager:
    MODEL_MAPPING: dict = {}


class BetterTransformer:
    @staticmethod
    def transform(model):  # type: ignore[no-untyped-def]
        return model
`
      );
    }

    const initPath = join(optimumDir, '__init__.py');
    if (!existsSync(initPath)) {
      writeFileSync(
        initPath,
        `# 占位 stub：让 infinity_emb 的 CHECK_OPTIMUM.is_available 返回 True，
# 但实际只提供空的 BetterTransformerManager，使 bettertransformer 转换不会触发。
from .bettertransformer import BetterTransformer, BetterTransformerManager

__all__ = ['BetterTransformer', 'BetterTransformerManager']
`
      );
    }

    logger.info({ optimumDir }, '已确保 optimum bettertransformer 占位 stub');
  }

  private async startCapability(capability: ModelCapability, model: string, force = false): Promise<void> {
    if (!force) {
      const existing = capability === 'embedding' ? this.embeddingServer : this.rerankServer;
      if (existing?.isHealthy()) return;
    }

    const server = new ModelServer({ capability, model, venvDir: this.venvDir });
    const url = await server.start();
    if (capability === 'embedding') {
      this.embeddingServer = server;
    } else {
      this.rerankServer = server;
    }

    let restartCount = 0;
    const maxRestarts = 3;
    const attemptRestart = async () => {
      if (this.stopping || restartCount >= maxRestarts) {
        if (restartCount >= maxRestarts) {
          logger.warn({ capability }, `本地 ${capability} 模型服务连续重启失败，停止重试`);
        }
        return;
      }
      restartCount++;
      logger.warn({ capability, restartCount }, `本地 ${capability} 模型服务异常，尝试重启`);
      try {
        await server.start();
        restartCount = 0;
        logger.info({ capability }, `本地 ${capability} 模型服务重启成功`);
      } catch (err) {
        logger.warn({ err }, `本地 ${capability} 模型服务重启失败`);
      }
    };

    server.onExit(() => {
      attemptRestart();
    });

    logger.info({ capability, url, model }, `本地 ${capability} 模型服务已启动`);
  }

  private async findPython(): Promise<string> {
    const candidates = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
    for (const cmd of candidates) {
      try {
        await this.runCommand(cmd, ['--version']);
        return cmd;
      } catch {
        // 继续尝试下一个
      }
    }
    throw new Error('未找到 Python 解释器，请安装 Python 3.12+');
  }

  private async runCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`命令失败: ${command} ${args.join(' ')}，code=${code}，stderr=${stderr}`));
      });
    });
  }
}
