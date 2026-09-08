/**
 * Role 节点运行时：管线中 role.* 节点的执行载体。
 *
 * 每个 (项目, 角色) 节点实例对应一个长驻子进程（fork role-entry），
 * 触发时通过 IPC 发送 run 指令、等待 done/error，替代旧版
 * "全局角色进程 + 项目轮询" 模型。子进程崩溃后在下次触发时惰性重建。
 */

import { fork, type ChildProcess } from 'node:child_process';
import { logger } from '../core/logger.js';
import type { Project, Role } from '../types.js';

export interface RoleNodeRuntimeOptions {
  /** role-entry.js 的路径 */
  runnerPath: string;
  /** SQLite 元数据库路径（延迟取值：daemon 构造期间 context 尚未补全） */
  getDbPath: () => string;
  /** 守护进程配置（LLM 参数注入子进程） */
  getDaemonConfig: () => {
    apiKey?: string;
    provider?: string;
    model?: string;
    apiUrl?: string;
    headers?: Record<string, string> | string;
    llmRequestsPerMinute?: number;
  };
  /** EverOS MCP URL（启动子进程前必须就绪） */
  getMcpUrl: () => string | null;
  /** CodeGraph Server URL */
  getCodeGraphUrl: () => string | null;
  /** 等待子进程 ready 的超时（毫秒），默认 30s；测试可注入更短值 */
  readyTimeoutMs?: number;
}

interface InstanceEntry {
  child: ChildProcess;
  ready: Promise<void>;
  running: boolean;
}

/** 等待子进程 ready 的超时 */
const READY_TIMEOUT_MS = 30_000;

export class RoleNodeRuntime {
  private instances = new Map<string, InstanceEntry>();

  constructor(private readonly options: RoleNodeRuntimeOptions) {}

  /**
   * 触发一个 (项目, 角色) 节点实例执行单次循环。
   * 子进程不存在/已退出时惰性 fork；执行期间（含 ready 等待窗口）重入会被跳过，
   * 等价于旧版"上一次未完成则跳过"。
   */
  async runOnce(project: Project, role: Role): Promise<void> {
    const key = instanceKey(project.id, role);
    let entry = this.instances.get(key);
    if (entry?.running) {
      logger.warn(`[RoleNode] ${key} 上一次执行尚未完成，跳过本次触发`);
      return;
    }
    if (!entry) {
      entry = await this.spawn(project, role);
      this.instances.set(key, entry);
    }
    // running 置位必须先于 ready 等待，堵住冷启动窗口的双派发
    entry.running = true;
    try {
      await entry.ready;
      await this.dispatchRun(entry.child, key);
    } catch (error) {
      // ready 失败/执行期子进程异常：清表，下次触发重建
      if (this.instances.get(key) === entry) {
        this.instances.delete(key);
      }
      throw error;
    } finally {
      entry.running = false;
    }
  }

  /** 停止指定 (项目, 角色) 实例（重启语义：下次触发时重新 fork）；3 秒未退出则 SIGKILL */
  stopInstance(projectId: string, role: Role): void {
    const key = instanceKey(projectId, role);
    const entry = this.instances.get(key);
    if (entry) {
      this.instances.delete(key);
      terminateWithFallback(entry.child, key);
    }
  }

  /** 停止某角色的全部实例（角色服务停止语义） */
  stopRole(role: Role): void {
    for (const [key, entry] of this.instances) {
      if (key.endsWith(`:${role}`)) {
        this.instances.delete(key);
        terminateWithFallback(entry.child, key);
      }
    }
  }

  /** 停止某项目的全部节点实例（项目注销语义） */
  stopProject(projectId: string): void {
    for (const [key, entry] of this.instances) {
      if (key.startsWith(`${projectId}:`)) {
        this.instances.delete(key);
        terminateWithFallback(entry.child, key);
      }
    }
  }

  /** 停止全部实例（daemon 关闭语义） */
  stopAll(): void {
    for (const [key, entry] of this.instances) {
      terminateWithFallback(entry.child, key);
    }
    this.instances.clear();
  }

  /** 某角色当前存活的节点实例数 */
  countInstances(role: Role): number {
    let count = 0;
    for (const key of this.instances.keys()) {
      if (key.endsWith(`:${role}`)) count += 1;
    }
    return count;
  }

  private async spawn(project: Project, role: Role): Promise<InstanceEntry> {
    const daemonConfig = this.options.getDaemonConfig();
    const child = fork(this.options.runnerPath, [], {
      env: {
        ...process.env,
        ROLE: role,
        CK_PROJECT_ID: project.id,
        CK_DB_PATH: this.options.getDbPath(),
        CK_EVEROS_MCP_URL: this.options.getMcpUrl() ?? '',
        CK_CODEGRAPH_SERVER_URL: this.options.getCodeGraphUrl() ?? '',
        CK_LLM_API_KEY: daemonConfig.apiKey ?? '',
        CK_LLM_PROVIDER: daemonConfig.provider ?? 'anthropic',
        CK_LLM_MODEL: daemonConfig.model ?? '',
        CK_LLM_API_URL: daemonConfig.apiUrl ?? '',
        CK_LLM_HEADERS:
          typeof daemonConfig.headers === 'string'
            ? daemonConfig.headers
            : JSON.stringify(daemonConfig.headers ?? {}),
        CK_LLM_RPM: String(daemonConfig.llmRequestsPerMinute ?? 10),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    child.stdout?.on('data', data => {
      logger.info({ role, project: project.id, output: String(data).trim() }, '[Role Node]');
    });
    child.stderr?.on('data', data => {
      logger.warn({ role, project: project.id, output: String(data).trim() }, '[Role Node]');
    });

    const key = instanceKey(project.id, role);
    const entry: InstanceEntry = {
      child,
      running: false,
      ready: new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          // 超时必须终止并清表，避免残留实例反复 await 已 reject 的 ready
          this.instances.delete(key);
          child.kill('SIGKILL');
          reject(new Error(`[RoleNode] ${key} 等待 ready 超时`));
        }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
        const onMessage = (message: unknown) => {
          if (isNodeMessage(message) && message.type === 'ready') {
            cleanup();
            resolve();
          }
        };
        // 子进程启动即崩时立即 reject，不掩盖真实错误
        const onExit = (code: number | null) => {
          cleanup();
          reject(new Error(`[RoleNode] ${key} 子进程在 ready 前退出，code=${code}`));
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.off('message', onMessage);
          child.off('exit', onExit);
        };
        child.on('message', onMessage);
        child.on('exit', onExit);
      }),
    };

    child.on('exit', code => {
      logger.info(`[RoleNode] ${key} 子进程退出，code=${code}`);
      // 崩溃后清表，下次触发时惰性重建
      if (this.instances.get(key) === entry) {
        this.instances.delete(key);
      }
    });

    return entry;
  }

  private dispatchRun(child: ChildProcess, key: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (!isNodeMessage(message)) return;
        if (message.type === 'done') {
          cleanup();
          resolve();
        } else if (message.type === 'error') {
          cleanup();
          reject(new Error(message.message));
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`[RoleNode] ${key} 执行期间子进程退出，code=${code}`));
      };
      const cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
      child.send({ type: 'run' }, (error: Error | null) => {
        if (error) {
          cleanup();
          reject(error);
        }
      });
    });
  }
}

function instanceKey(projectId: string, role: Role): string {
  return `${projectId}:${role}`;
}

/** SIGTERM 后 3 秒未退出则 SIGKILL（对齐旧版 restartProject 的兜底） */
function terminateWithFallback(child: ChildProcess, key: string): void {
  const timer = setTimeout(() => {
    logger.warn(`[RoleNode] ${key} 子进程未在 3 秒内退出，强制结束`);
    child.kill('SIGKILL');
  }, 3000);
  child.once('exit', () => clearTimeout(timer));
  child.kill('SIGTERM');
}

interface NodeMessage {
  type: 'ready' | 'done' | 'error';
  message?: string;
}

function isNodeMessage(value: unknown): value is NodeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}
