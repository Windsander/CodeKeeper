import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

  private async ensureVenv(): Promise<void> {
    const cli = join(this.venvDir, process.platform === 'win32' ? 'Scripts\\infinity_emb.exe' : 'bin/infinity_emb');
    if (existsSync(cli)) return;

    await mkdir(this.venvDir, { recursive: true });
    const python = await this.findPython();
    await this.runCommand(python, ['-m', 'venv', this.venvDir]);
    const pip = join(this.venvDir, process.platform === 'win32' ? 'Scripts\\pip.exe' : 'bin/pip');
    // 使用 [server,torch] 而不是 [optimum]，避免 optimum 2.x 移除 bettertransformer 导致不兼容
    await this.runCommand(pip, ['install', '-U', 'infinity-emb[server,torch]', 'click<8.2']);
    this.ensureOptimumStub();
  }

  /**
   * infinity_emb 0.0.77 在未安装 optimum 时会因 BetterTransformer 导入失败。
   * 提供一个空 stub，使检查返回 False，从而跳过 bettertransformer 转换。
   */
  private ensureOptimumStub(): void {
    const sitePackages = join(this.venvDir, process.platform === 'win32' ? 'Lib\\site-packages' : 'lib/python3.12/site-packages');
    const optimumDir = join(sitePackages, 'optimum');
    if (existsSync(join(optimumDir, '__init__.py'))) return;

    mkdirSync(optimumDir, { recursive: true });
    writeFileSync(
      join(optimumDir, '__init__.py'),
      "# 占位 stub：让 infinity_emb 的 CHECK_OPTIMUM.is_available 返回 True，\\n" +
        "# 但实际只提供空的 BetterTransformerManager，使 bettertransformer 转换不会触发。\\n" +
        "from .bettertransformer import BetterTransformer, BetterTransformerManager\\n\\n" +
        "__all__ = ['BetterTransformer', 'BetterTransformerManager']\\n"
    );
    writeFileSync(
      join(optimumDir, 'bettertransformer.py'),
      "# 占位 stub：避免 infinity_emb 在 optimum 未安装时触发 ModuleNotFoundError。\\n" +
        "# 实际不会使用 BetterTransformer，因为 MODEL_MAPPING 为空。\\n" +
        "class BetterTransformerManager:\\n" +
        "    MODEL_MAPPING: dict = {}\\n\\n" +
        "class BetterTransformer:\\n" +
        "    @staticmethod\\n" +
        "    def transform(model):\\n" +
        "        return model\\n"
    );
    logger.info({ optimumDir }, '已创建 optimum bettertransformer 占位 stub');
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
