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
   * 总管服务始终 fork 子进程，由子进程周期性读取数据库中的启用项目，
   * 动态启动或停止对应项目的 Agent 循环。
   * 即使当前没有启用项目，监控服务本身也应保持运行，以便后续动态响应项目启用/禁用变化。
   */
  start(): void {
    if (this.child) {
      logger.warn(`角色 ${this.role} 服务已在运行`);
      return;
    }

    const child = fork(this.runnerPath, [], {
      env: {
        ...process.env,
        ROLE: this.role,
        CK_DB_PATH: this.context.dbPath,
        CK_LLM_API_KEY: this.context.getDaemonConfig?.().apiKey ?? '',
        CK_LLM_PROVIDER: this.context.getDaemonConfig?.().provider ?? 'anthropic',
        CK_LLM_MODEL: this.context.getDaemonConfig?.().model ?? '',
        CK_LLM_API_URL: this.context.getDaemonConfig?.().apiUrl ?? '',
        CK_LLM_HEADERS: this.context.getDaemonConfig?.().headers ?? '{}',
        CK_LLM_RPM: String(this.context.getDaemonConfig?.().llmRequestsPerMinute ?? 10),
      },
      stdio: 'pipe',
    });
    this.child = child;

    child.stdout?.on('data', (data) => {
      logger.info({ role: this.role, output: data.toString().trim() }, '[Role Agent]');
    });
    child.stderr?.on('data', (data) => {
      logger.warn({ role: this.role, output: data.toString().trim() }, '[Role Agent]');
    });

    child.on('exit', (code) => {
      logger.info(`角色 ${this.role} 子进程退出，code=${code}`);
      // 防止旧子进程的 exit 事件在 restart 后把新子进程引用清空
      if (this.child === child) {
        this.child = null;
      }
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
   * 当前实现：停止并重启整个角色服务，等待旧子进程退出后再启动新子进程，
   * 避免数据库锁或端口等资源冲突。
   */
  async restartProject(_projectId: string): Promise<void> {
    if (!this.child) {
      this.start();
      return;
    }

    const oldChild = this.child;
    // 先清空引用，防止旧子进程的 exit 事件误清掉后续新子进程
    this.child = null;
    oldChild.kill('SIGTERM');

    // 等待旧子进程退出，最多 3 秒；超时则强制结束
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`角色 ${this.role} 旧子进程未在 3 秒内退出，强制结束`);
        oldChild.kill('SIGKILL');
        resolve();
      }, 3000);
      oldChild.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

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
