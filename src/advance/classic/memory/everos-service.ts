import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../../../core/logger.js';
import { getAppStorageDir } from '../../../core/platform.js';

export interface EverOSServiceOptions {
  /** EverOS submodule 根目录 */
  submodulePath: string;
  /** 数据目录；默认 ~/.codekeeper/everos-data */
  dataDir?: string;
  /** 指定端口；0 表示由 EverOS 自己选择 */
  port?: number;
}

/**
 * 管理 EverOS 本地服务的生命周期
 */
export class EverOSService {
  private process: ChildProcess | null = null;
  private readonly submodulePath: string;
  private readonly dataDir: string;
  private readonly port: number;
  private everosUrl: string | null = null;

  constructor(options: EverOSServiceOptions) {
    this.submodulePath = resolve(options.submodulePath);
    this.dataDir = options.dataDir ?? join(getAppStorageDir(), 'everos-data');
    this.port = options.port ?? 0;
  }

  /**
   * 启动 EverOS 服务
   * @returns EverOS HTTP URL，例如 http://127.0.0.1:8000
   */
  async start(): Promise<string> {
    if (this.process) {
      return this.everosUrl!;
    }

    await this.ensureVenv();
    await mkdir(this.dataDir, { recursive: true });
    await this.checkCompatibility();
    await this.ensureInitialized();

    const everosCli = this.everosCliPath();
    const args = ['server', 'start', '--root', this.dataDir, '--port', String(this.port)];

    logger.info({ everosCli, args }, '启动 EverOS 服务');

    return new Promise((resolve, reject) => {
      const child = spawn(everosCli, args, {
        cwd: this.submodulePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.process = child;

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
        this.process = null;
        reject(new Error(`启动 EverOS 失败: ${err.message}`));
      });

      child.on('exit', (code) => {
        this.process = null;
        if (!this.everosUrl) {
          reject(new Error(`EverOS 进程退出 code=${code}, stderr=${stderr}`));
        }
      });

      setTimeout(() => {
        if (!this.everosUrl) {
          this.stop();
          reject(new Error('EverOS 启动超时，未检测到服务 URL'));
        }
      }, 60000);
    });
  }

  /**
   * 停止 EverOS 服务
   */
  stop(): void {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    const proc = this.process;
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 5000);
    this.process = null;
    this.everosUrl = null;
  }

  private async ensureVenv(): Promise<void> {
    const cli = this.everosCliPath();
    if (existsSync(this.venvPath()) && existsSync(cli)) return;

    const python = await this.findPython();
    const venvPath = this.venvPath();
    if (!existsSync(venvPath)) {
      logger.info({ python, venvPath }, '创建 EverOS 虚拟环境');
      await this.runCommand(python, ['-m', 'venv', venvPath]);
    }

    const pip = this.pipPath();
    logger.info({ pip }, '安装 EverOS 依赖');
    await this.runCommand(pip, ['install', '-e', this.submodulePath]);
  }

  private async ensureInitialized(): Promise<void> {
    const configPath = join(this.dataDir, 'everos.toml');
    if (existsSync(configPath)) return;
    const everosCli = this.everosCliPath();
    logger.info({ dataDir: this.dataDir }, '初始化 Ever OS 配置');
    await this.runCommand(everosCli, ['init', '--root', this.dataDir]);
  }

  /**
   * 检查当前环境是否能运行 EverOS（依赖 Unix-only 的 fcntl）
   */
  private async checkCompatibility(): Promise<void> {
    try {
      await this.runCommand(this.pythonPath(), ['-c', 'import fcntl']);
    } catch {
      throw new Error(
        'EverOS 当前运行环境不兼容（缺少 Unix-only 依赖 fcntl），请在 Linux/macOS/WSL 下使用本地记忆功能'
      );
    }
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
      const child = spawn(command, args, { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`命令失败: ${command} ${args.join(' ')}，code=${code}`));
      });
    });
  }

  private venvPath(): string {
    return join(getAppStorageDir(), 'everos-venv');
  }

  private pythonPath(): string {
    return join(this.venvPath(), process.platform === 'win32' ? 'python.exe' : 'bin/python');
  }

  private pipPath(): string {
    return join(this.venvPath(), process.platform === 'win32' ? 'Scripts\\pip.exe' : 'bin/pip');
  }

  private everosCliPath(): string {
    return join(this.venvPath(), process.platform === 'win32' ? 'Scripts\\everos.exe' : 'bin/everos');
  }

  private tryParseUrl(stdout: string, resolve: (url: string) => void): void {
    if (this.everosUrl) return;
    // Uvicorn 启动时会打印服务器 URL，例如: Uvicorn running on http://127.0.0.1:8000
    const match = stdout.match(/(https?:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      this.everosUrl = match[1];
      resolve(this.everosUrl);
    }
  }
}
