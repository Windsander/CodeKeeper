/**
 * Classic Service
 *
 * 负责管理 MR 自动评审 Agent 子进程的生命周期。
 * MR Agent 作为独立子进程运行，不耦合 advance daemon 的事件循环。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../core/logger.js';
import { buildMrAgentEnv } from './classic-config-builder.js';
import type { MetadataStore } from '../store/metadata-store.js';
import type { ProjectRegistry } from '../project-registry.js';

export interface ClassicServiceOptions {
  /** 元数据存储 */
  store: MetadataStore;
  /** 项目注册表 */
  registry: ProjectRegistry;
  /** 获取当前 daemon LLM 配置的回调 */
  getDaemonConfig: () => {
    apiKey: string;
    provider: 'anthropic' | 'openai';
    model: string;
    apiUrl: string;
    headers?: Record<string, string>;
  };
  /** 用于测试的 spawn 覆盖 */
  spawn?: typeof spawn;
}

export class ClassicService {
  private child: ChildProcess | null = null;

  constructor(private options: ClassicServiceOptions) {}

  /**
   * 启动 MR Agent 子进程
   *
   * 从 advance daemon 配置和项目注册表中构造环境变量，
   * 然后 spawn 独立子进程执行 mr-agent-entry.js。
   */
  start(): void {
    if (this.child) {
      logger.info('[ClassicService] MR Agent 已在运行，跳过启动');
      return;
    }

    const projects = this.options.registry.list();
    const daemonConfig = this.options.getDaemonConfig();
    const env = buildMrAgentEnv(projects, {
      apiKey: daemonConfig.apiKey,
      provider: daemonConfig.provider,
      model: daemonConfig.model,
      apiUrl: daemonConfig.apiUrl,
      headers: daemonConfig.headers ? JSON.stringify(daemonConfig.headers) : '',
    });

    const entryPath = path.join(__dirname, 'mr-agent-entry.js');

    logger.info('[ClassicService] 启动 MR Agent 子进程');
    const spawnFn = this.options.spawn ?? spawn;
    this.child = spawnFn('node', [entryPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (data) => {
      logger.info({ msg: data.toString().trim() }, '[MR Agent]');
    });
    this.child.stderr?.on('data', (data) => {
      logger.warn({ msg: data.toString().trim() }, '[MR Agent]');
    });
    this.child.on('exit', (code) => {
      logger.info(`[ClassicService] MR Agent 子进程退出，退出码: ${code}`);
      this.child = null;
    });
  }

  /**
   * 停止 MR Agent 子进程
   */
  stop(): void {
    if (!this.child) {
      logger.info('[ClassicService] MR Agent 未运行，跳过停止');
      return;
    }
    logger.info('[ClassicService] 停止 MR Agent 子进程');
    this.child.kill('SIGTERM');
    this.child = null;
  }

  /**
   * 重启 MR Agent 子进程
   */
  restart(): void {
    logger.info('[ClassicService] 重启 MR Agent 子进程');
    this.stop();
    this.start();
  }

  /**
   * 查询子进程是否正在运行
   */
  isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }
}
