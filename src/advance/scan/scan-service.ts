/**
 * 归档扫描服务
 *
 * 负责在独立 worker 子进程中执行归档扫描，避免阻塞 daemon 主进程的事件循环。
 */

import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../core/logger.js';
import type { MetadataStore } from '../store/metadata-store.js';
import type { ProjectRegistry } from '../project-registry.js';
import type { Project } from '../types.js';

export interface ScanServiceOptions {
  /** 元数据存储（用于读取项目列表等） */
  store: MetadataStore;
  /** 项目注册表 */
  registry: ProjectRegistry;
  /** 数据库文件路径，worker 需要独立打开 */
  dbPath: string;
  /** 获取当前 daemon LLM 配置的回调 */
  getDaemonConfig: () => {
    apiKey: string;
    apiUrl: string;
    provider: 'anthropic' | 'openai';
    model: string;
    headers: Record<string, string>;
  };
  /** 每次扫描最多处理事件数 */
  maxEventsPerScan?: number;
}

interface ScanWorkerMessage {
  type: 'progress' | 'done' | 'error';
  projectId?: string;
  stage?: 'scanning' | 'processing';
  message?: string;
}

export class ScanService {
  private child: ChildProcess | null = null;
  private running = false;

  constructor(private options: ScanServiceOptions) {}

  /**
   * 扫描所有已注册项目
   *
   * 如果当前已有扫描任务进行中，则跳过本次调度。
   */
  scanAllProjects(): void {
    if (this.running) {
      logger.info('[ScanService] 已有扫描任务进行中，跳过本次调度');
      return;
    }

    const projects = this.options.registry.list();
    if (projects.length === 0) {
      logger.info('[ScanService] 没有注册项目，跳过扫描');
      return;
    }

    this.startWorker(projects);
  }

  /**
   * 扫描指定项目
   *
   * 如果当前已有扫描任务进行中，会抛出错误。
   */
  scanProject(projectId: string): void {
    if (this.running) {
      throw new Error('已有扫描任务进行中，请等待完成');
    }

    const project = this.options.registry.get(projectId);
    if (!project) {
      throw new Error('项目未注册');
    }

    this.startWorker([project]);
  }

  /**
   * 当前是否有扫描任务在运行
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 停止当前扫描任务
   */
  stop(): void {
    if (this.child && !this.child.killed) {
      logger.info('[ScanService] 停止当前扫描任务');
      this.child.kill('SIGTERM');
    }
  }

  private startWorker(projects: Project[]): void {
    this.running = true;

    const entryPath = path.join(__dirname, 'scan-worker-entry.js');
    logger.info('[ScanService] 启动扫描 worker');

    const child = fork(entryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;

    child.stdout?.on('data', (data) => {
      logger.info({ msg: data.toString().trim() }, '[Scan Worker]');
    });
    child.stderr?.on('data', (data) => {
      logger.warn({ msg: data.toString().trim() }, '[Scan Worker]');
    });

    child.on('message', (msg: ScanWorkerMessage) => {
      switch (msg.type) {
        case 'progress':
          logger.info(
            { projectId: msg.projectId, stage: msg.stage },
            '[ScanService] 扫描进度'
          );
          break;
        case 'done':
          logger.info('[ScanService] 扫描任务完成');
          break;
        case 'error':
          logger.error({ message: msg.message }, '[ScanService] 扫描任务出错');
          break;
      }
    });

    child.on('exit', (code) => {
      logger.info({ exitCode: code }, '[ScanService] 扫描 worker 退出');
      this.child = null;
      this.running = false;
    });

    const daemonConfig = this.options.getDaemonConfig();
    child.send({
      projects,
      dbPath: this.options.dbPath,
      daemonConfig,
      maxEventsPerScan: this.options.maxEventsPerScan ?? 10,
    });
  }
}
