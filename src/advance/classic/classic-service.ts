/**
 * Classic Service
 *
 * 负责管理 MR 自动评审 Agent 子进程的生命周期。
 * 采用调度器模式：启动服务后，按固定周期 reconcile 一次，
 * 根据各项目的启用状态自动 spawn/kill 对应的子进程。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../core/logger.js';
import { buildMrAgentEnv } from './classic-config-builder.js';
import type { MetadataStore } from '../store/metadata-store.js';
import type { ProjectRegistry } from '../project-registry.js';
import type { Project } from '../types.js';

/** 调度周期：每 1 秒 reconcile 一次，保证 checkbox 启停接近实时响应 */
const RECONCILE_INTERVAL_MS = 1000;

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
  /** projectId → ChildProcess */
  private children = new Map<string, ChildProcess>();
  /** 调度服务是否正在运行 */
  private running = false;
  /** 周期性 reconcile 定时器 */
  private intervalId?: NodeJS.Timeout;

  constructor(private options: ClassicServiceOptions) {}

  /**
   * 启动 MR Agent 调度服务
   *
   * 启动后会立即执行一次 reconcile，并按固定周期持续 reconcile。
   */
  start(): void {
    if (this.running) {
      logger.info('[ClassicService] MR Agent 调度服务已在运行，跳过启动');
      return;
    }

    this.running = true;
    logger.info('[ClassicService] 启动 MR Agent 调度服务');
    this.reconcile();
    this.intervalId = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
  }

  /**
   * 停止 MR Agent 调度服务
   *
   * 停止周期 reconcile，并杀掉所有正在运行的子进程。
   */
  stop(): void {
    if (!this.running) {
      logger.info('[ClassicService] MR Agent 调度服务未运行，跳过停止');
      return;
    }

    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    logger.info('[ClassicService] 停止 MR Agent 调度服务');
    for (const [projectId, child] of this.children) {
      child.kill('SIGTERM');
      logger.info(`[ClassicService] 已发送 SIGTERM 到项目 ${projectId} 的 MR Agent`);
    }
    this.children.clear();
  }

  /**
   * 重启 MR Agent 调度服务
   */
  restart(): void {
    logger.info('[ClassicService] 重启 MR Agent 调度服务');
    this.stop();
    this.start();
  }

  /**
   * 根据当前项目启用状态对账子进程
   *
   * - 对启用 MR 评审且配置了 GitLab 的项目：若未运行则 spawn
   * - 对已不在启用列表中的项目：若正在运行则 kill
   */
  reconcile(): void {
    if (!this.running) {
      return;
    }

    const projects = this.options.registry.list();
    const daemonConfig = this.options.getDaemonConfig();
    const enabledProjectIds = new Set<string>();

    for (const project of projects) {
      if (!project.mrReview?.enabled || !project.gitlab) {
        continue;
      }
      enabledProjectIds.add(project.id);

      if (this.isProjectRunning(project.id)) {
        continue;
      }

      this.spawnProjectAgent(project, daemonConfig);
    }

    for (const [projectId, child] of this.children) {
      if (!enabledProjectIds.has(projectId)) {
        child.kill('SIGTERM');
        this.children.delete(projectId);
        logger.info(`[ClassicService] 项目 ${projectId} 已禁用，停止其 MR Agent`);
      }
    }
  }

  /**
   * 重启指定项目的 MR Agent 子进程
   *
   * 用于项目配置（Token、schedule、角色等）变更后热重启该项目的 Agent。
   * 仅当调度服务正在运行时生效。
   */
  restartProject(projectId: string): void {
    if (!this.running) {
      return;
    }

    const child = this.children.get(projectId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    this.children.delete(projectId);

    this.reconcile();
  }

  /**
   * 查询调度服务是否正在运行
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 查询指定项目的 MR Agent 是否正在运行
   */
  isProjectRunning(projectId: string): boolean {
    const child = this.children.get(projectId);
    return Boolean(child && !child.killed);
  }

  /**
   * 获取当前运行中的 MR Agent 对应的项目 ID 列表
   */
  getRunningProjectIds(): string[] {
    const ids: string[] = [];
    for (const [projectId, child] of this.children) {
      if (!child.killed) {
        ids.push(projectId);
      }
    }
    return ids;
  }

  /**
   * 为指定项目 spawn 一个 MR Agent 子进程
   */
  private spawnProjectAgent(
    project: Project,
    daemonConfig: ReturnType<ClassicServiceOptions['getDaemonConfig']>
  ): void {
    const env = buildMrAgentEnv([project], {
      apiKey: daemonConfig.apiKey,
      provider: daemonConfig.provider,
      model: daemonConfig.model,
      apiUrl: daemonConfig.apiUrl,
      headers: daemonConfig.headers ? JSON.stringify(daemonConfig.headers) : '',
    });

    const entryPath = path.join(__dirname, 'mr-agent-entry.js');

    logger.info(`[ClassicService] 启动项目 ${project.name} 的 MR Agent 子进程`);
    const spawnFn = this.options.spawn ?? spawn;
    const child = spawnFn('node', [entryPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.children.set(project.id, child);

    child.stdout?.on('data', (data) => {
      logger.info({ projectId: project.id, msg: data.toString().trim() }, '[MR Agent]');
    });
    child.stderr?.on('data', (data) => {
      logger.warn({ projectId: project.id, msg: data.toString().trim() }, '[MR Agent]');
    });
    child.on('exit', (code) => {
      logger.info(
        `[ClassicService] 项目 ${project.name} 的 MR Agent 子进程退出，退出码: ${code}`
      );
      // 只有该 child 仍是当前记录的实例时才删除，避免 kill 后重新 spawn 的旧引用误删
      if (this.children.get(project.id) === child) {
        this.children.delete(project.id);
      }
    });
  }
}
