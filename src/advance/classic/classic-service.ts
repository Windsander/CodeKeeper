/**
 * Classic Service
 *
 * 负责管理 MR 自动评审 Agent 子进程的生命周期。
 * 每个启用 MR 评审的项目对应一个独立的子进程，实现项目级隔离。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { logger } from '../../core/logger.js';
import { buildMrAgentEnv } from './classic-config-builder.js';
import type { MetadataStore } from '../store/metadata-store.js';
import type { ProjectRegistry } from '../project-registry.js';
import type { Project } from '../types.js';

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

  constructor(private options: ClassicServiceOptions) {}

  /**
   * 启动所有启用 MR 评审项目的 Agent 子进程
   *
   * 遍历项目注册表，为每个启用 MR 评审且配置了 GitLab 的项目单独 spawn
   * 一个子进程。每个子进程只携带该项目的配置，实现项目级隔离。
   */
  start(): void {
    const projects = this.options.registry.list();
    const daemonConfig = this.options.getDaemonConfig();

    for (const project of projects) {
      if (!project.mrReview?.enabled || !project.gitlab) {
        continue;
      }

      // 若该项目 Agent 已在运行，跳过
      if (this.isProjectRunning(project.id)) {
        logger.info(`[ClassicService] 项目 ${project.name} 的 MR Agent 已在运行，跳过`);
        continue;
      }

      this.spawnProjectAgent(project, daemonConfig);
    }
  }

  /**
   * 停止所有 MR Agent 子进程
   */
  stop(): void {
    if (this.children.size === 0) {
      logger.info('[ClassicService] 没有运行中的 MR Agent，跳过停止');
      return;
    }

    logger.info(`[ClassicService] 停止 ${this.children.size} 个 MR Agent 子进程`);
    for (const [projectId, child] of this.children) {
      child.kill('SIGTERM');
      logger.info(`[ClassicService] 已发送 SIGTERM 到项目 ${projectId} 的 MR Agent`);
    }
    this.children.clear();
  }

  /**
   * 重启所有 MR Agent 子进程
   */
  restart(): void {
    logger.info('[ClassicService] 重启所有 MR Agent 子进程');
    this.stop();
    this.start();
  }

  /**
   * 启动指定项目的 MR Agent 子进程
   *
   * 仅在该项目启用 MR 评审、配置了 GitLab、且当前未运行时才会 spawn。
   * 调用方应自行判断全局服务是否运行。
   */
  startProject(projectId: string): void {
    if (this.isProjectRunning(projectId)) {
      logger.info(`[ClassicService] 项目 ${projectId} 的 MR Agent 已在运行，跳过`);
      return;
    }

    const project = this.options.registry.list().find((p) => p.id === projectId);
    if (!project) {
      logger.warn(`[ClassicService] 启动项目 ${projectId} 失败：项目不存在`);
      return;
    }

    if (!project.mrReview?.enabled || !project.gitlab) {
      logger.info(`[ClassicService] 项目 ${project.name} 未启用 MR 评审或未配置 GitLab，跳过启动`);
      return;
    }

    const daemonConfig = this.options.getDaemonConfig();
    this.spawnProjectAgent(project, daemonConfig);
  }

  /**
   * 停止指定项目的 MR Agent 子进程
   */
  stopProject(projectId: string): void {
    const child = this.children.get(projectId);
    if (!child || child.killed) {
      logger.info(`[ClassicService] 项目 ${projectId} 的 MR Agent 未运行，跳过停止`);
      return;
    }

    child.kill('SIGTERM');
    this.children.delete(projectId);
    logger.info(`[ClassicService] 已停止项目 ${projectId} 的 MR Agent`);
  }

  /**
   * 重启指定项目的 MR Agent 子进程
   *
   * 用于项目配置（Token、schedule、角色等）变更后热重启该项目的 Agent。
   * 会先停止再启动；若项目未启用或未配置 GitLab，则只停止不启动。
   */
  restartProject(projectId: string): void {
    const project = this.options.registry.list().find((p) => p.id === projectId);
    if (!project) {
      logger.warn(`[ClassicService] 重启项目 ${projectId} 失败：项目不存在`);
      return;
    }

    logger.info(`[ClassicService] 重启项目 ${project.name} 的 MR Agent`);

    const child = this.children.get(projectId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    this.children.delete(projectId);

    if (project.mrReview?.enabled && project.gitlab) {
      const daemonConfig = this.options.getDaemonConfig();
      this.spawnProjectAgent(project, daemonConfig);
    }
  }

  /**
   * 查询是否至少有一个 MR Agent 子进程正在运行
   */
  isRunning(): boolean {
    return this.getRunningProjectIds().length > 0;
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
