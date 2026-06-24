import { fork, type ChildProcess } from 'node:child_process';
import { logger } from '../../core/logger.js';
import type { Role } from '../types.js';
import type { HandlerContext } from '../ipc/handlers.js';

/**
 * 角色服务运行状态
 */
export interface RoleServiceStatus {
  /** 服务是否正在运行 */
  running: boolean;
  /** 该角色启用的项目数量 */
  enabledProjects: number;
  /** 正在运行的项目 ID 列表 */
  runningProjects: string[];
}

/**
 * 按角色实例化的服务管理器
 * 负责为单个角色 fork 子进程并管理其生命周期
 */
export class RoleService {
  private child: ChildProcess | null = null;

  constructor(
    private role: Role,
    private context: HandlerContext,
    private runnerPath: string,
  ) {}

  /**
   * 启动角色服务
   * 若该角色没有启用项目，则跳过启动
   */
  start(): void {
    if (this.child) {
      logger.warn(`角色 ${this.role} 服务已在运行`);
      return;
    }

    const enabledProjects = this.context.store.getRoleEnabledProjects(this.role);
    if (enabledProjects.length === 0) {
      logger.info(`角色 ${this.role} 没有启用项目，跳过启动`);
      return;
    }

    this.child = fork(this.runnerPath, [], {
      env: { ...process.env, ROLE: this.role },
      stdio: 'pipe',
    });

    this.child.on('exit', (code) => {
      logger.info(`角色 ${this.role} 子进程退出，code=${code}`);
      this.child = null;
    });
  }

  /**
   * 停止角色服务
   */
  stop(): void {
    if (!this.child) return;
    this.child.kill('SIGTERM');
    this.child = null;
  }

  /**
   * 重启指定项目的服务
   * 当前实现：停止并重启整个角色服务
   */
  restartProject(_projectId: string): void {
    this.stop();
    this.start();
  }

  /**
   * 获取角色服务当前状态
   */
  getStatus(): RoleServiceStatus {
    const enabledProjects = this.context.store.getRoleEnabledProjects(this.role);
    return {
      running: this.child !== null,
      enabledProjects: enabledProjects.length,
      runningProjects: enabledProjects.map((p) => p.id),
    };
  }
}
