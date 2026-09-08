/**
 * 管线调度器：daemon 侧的管线生命周期中枢。
 *
 * 职责：
 * - 项目加载时确保管线正本存在（旧角色配置自动迁移为默认 pipeline.yaml）
 * - 按 trigger.cron 节点注册调度，触发后经 PipelineExecutor 执行该触发器的下游子图
 * - role.* 节点经 RoleNodeRuntime 派发到 (项目, 角色) 级子进程执行
 * - 对外保持旧 RoleServiceRegistry 的接口表面（start/stop/restartProject/getStatus），
 *   供 IPC handlers 与 daemon 平滑切换
 */

import { schedule, validate as validateCron, type ScheduledTask } from 'node-cron';
import { logger } from '../core/logger.js';
import type { HandlerContext } from '../ipc/handlers.js';
import type { Project, Role } from '../types.js';
import { ROLES } from '../types.js';
import { recordAgentStarted, recordProjectError } from '../classic/status/project-status-store.js';
import { PipelineExecutor } from './core/executor.js';
import { PipelineRunStore } from './core/run-store.js';
import type { NodeHandler, RunContext } from './core/types.js';
import type { PipelineDefinition } from './core/types.js';
import {
  DEFAULT_ROLE_SCHEDULES,
  ensurePipelineDefinition,
  loadProjectPipeline,
} from './default-pipeline.js';
import { RoleNodeRuntime } from '../classic/role-node-runtime.js';

export interface PipelineSchedulerOptions {
  /** EverOS MCP Server URL（由 daemon 启动后回设） */
  mcpUrl?: string;
  /** CodeGraph Server URL（由 daemon 启动后回设） */
  codeGraphUrl?: string;
}

/** 与旧 RoleServiceStatus 保持兼容的状态结构 */
export interface RoleServiceStatus {
  running: boolean;
  enabledProjects: number;
  runningProjects: string[];
}

export class PipelineScheduler {
  public context: HandlerContext;
  private readonly runtime: RoleNodeRuntime;
  private runStore: PipelineRunStore | null = null;
  private readonly activeRoles = new Set<Role>();
  private readonly registeredRoles = new Set<Role>();
  /** 已注册的触发任务：key = projectId:nodeId（同角色多节点互不覆盖） */
  private readonly jobs = new Map<
    string,
    { projectId: string; role: Role; nodeId: string; task: ScheduledTask }
  >();
  private options: PipelineSchedulerOptions;

  constructor(context: HandlerContext, runnerPath: string, options: PipelineSchedulerOptions = {}) {
    this.context = context;
    this.options = options;
    this.runtime = new RoleNodeRuntime({
      runnerPath,
      getDbPath: () => this.context.dbPath,
      getDaemonConfig: () => this.context.getDaemonConfig?.() ?? {},
      getMcpUrl: () => this.options.mcpUrl ?? null,
      getCodeGraphUrl: () => this.options.codeGraphUrl ?? null,
    });
  }

  register(role: Role): void {
    this.registeredRoles.add(role);
  }

  /** 启动角色：等待基础设施 URL 就绪后激活该角色的全部管线触发器 */
  async start(role: Role): Promise<void> {
    if (!this.registeredRoles.has(role)) {
      throw new Error(`角色 ${role} 未注册`);
    }
    await this.waitForMemoryMcpUrl(60000);
    await this.waitForCodeGraphUrl(60000);
    this.activeRoles.add(role);
    this.rescheduleAll();
    logger.info(`[Pipeline] 角色 ${role} 的管线触发器已激活`);
    // 行为对拍：旧版 startProjectLoop 会立即执行一次，这里激活后立即触发一轮
    for (const project of this.context.store.getRoleEnabledProjects(role)) {
      void this.runRoleNow(project, role).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Pipeline] 项目 ${project.name} 角色 ${role} 首次执行失败: ${message}`);
      });
    }
  }

  /** 停止角色：摘除触发器并终止该角色的全部节点子进程 */
  async stop(role: Role): Promise<void> {
    this.activeRoles.delete(role);
    for (const [key, entry] of [...this.jobs.entries()]) {
      if (entry.role === role) {
        entry.task.stop();
        this.jobs.delete(key);
      }
    }
    this.runtime.stopRole(role);
    logger.info(`[Pipeline] 角色 ${role} 的管线触发器已停止`);
  }

  /**
   * 重启指定项目的角色节点：终止其节点子进程，下次触发时惰性重建。
   * （旧实现会重启整个角色服务；节点实例化后重启粒度收敛为单项目单角色。）
   * 若项目该角色处于启用且激活状态，立即执行一轮以对账（对齐旧版重启后立即执行的语义）。
   */
  async restartProject(role: Role, projectId: string): Promise<void> {
    this.runtime.stopInstance(projectId, role);
    if (!this.activeRoles.has(role)) {
      await this.start(role);
      return;
    }
    this.rescheduleAll();
    const project = this.context.store.getProject(projectId);
    if (project) {
      const enabled = this.context.store.getRoleEnabledProjects(role).some(p => p.id === projectId);
      if (enabled) {
        // 异步对账：不把整轮角色执行（可达数分钟）阻塞在配置保存 IPC 上
        void this.runRoleNow(project, role).catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(
            `[Pipeline] 项目 ${project.name} 角色 ${role} 重启后立即执行失败: ${message}`
          );
        });
      }
    }
  }

  /** 整角色重启（不传项目时）：重建该角色全部实例并重排，立即对账启用项目 */
  async restartRole(role: Role): Promise<void> {
    this.runtime.stopRole(role);
    if (!this.activeRoles.has(role)) {
      await this.start(role);
      return;
    }
    this.rescheduleAll();
    for (const project of this.context.store.getRoleEnabledProjects(role)) {
      void this.runRoleNow(project, role).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Pipeline] 项目 ${project.name} 角色 ${role} 重启后立即执行失败: ${message}`);
      });
    }
  }

  getStatus(role: Role): RoleServiceStatus {
    const enabledProjects = this.context.store.getRoleEnabledProjects(role);
    return {
      running: this.activeRoles.has(role),
      enabledProjects: enabledProjects.length,
      runningProjects: enabledProjects.map(p => p.id),
    };
  }

  /** daemon 启动 EverOS 后回设 */
  setMemoryMcpUrl(url: string): void {
    this.options = { ...this.options, mcpUrl: url };
  }

  /** daemon 启动 CodeGraph 后回设 */
  setCodeGraphUrl(url: string): void {
    this.options = { ...this.options, codeGraphUrl: url };
  }

  /**
   * 项目注册/配置变化后重建其调度，并重启该项目全部节点实例
   * （子进程持有启动时项目快照，必须重建才能读到新配置）。
   * 角色配置更新、项目注册、画布写回 YAML 都经此感知。
   */
  reloadProject(projectId: string): void {
    for (const key of [...this.jobs.keys()]) {
      if (this.jobs.get(key)?.projectId === projectId) {
        this.jobs.get(key)?.task.stop();
        this.jobs.delete(key);
      }
    }
    this.runtime.stopProject(projectId);
    const project = this.context.store.getProject(projectId);
    if (project) {
      this.scheduleProject(project);
    }
  }

  /** 项目注销：摘除其全部触发器并终止节点实例 */
  unloadProject(projectId: string): void {
    for (const key of [...this.jobs.keys()]) {
      if (this.jobs.get(key)?.projectId === projectId) {
        this.jobs.get(key)?.task.stop();
        this.jobs.delete(key);
      }
    }
    this.runtime.stopProject(projectId);
  }

  /** 全部项目重排（角色启停、daemon 启动时调用） */
  rescheduleAll(): void {
    for (const entry of this.jobs.values()) entry.task.stop();
    this.jobs.clear();
    for (const project of this.context.store.listProjects()) {
      this.scheduleProject(project);
    }
  }

  /** daemon 关闭：停全部触发器与节点子进程 */
  async stopAll(): Promise<void> {
    for (const entry of this.jobs.values()) entry.task.stop();
    this.jobs.clear();
    this.runtime.stopAll();
  }

  private scheduleProject(project: Project): void {
    if (this.activeRoles.size === 0) return;

    ensurePipelineDefinition(project);
    const definition = loadProjectPipeline(project);
    if (!definition) return;

    for (const node of definition.nodes) {
      if (!node.type.startsWith('role.')) continue;
      const role = node.type.slice('role.'.length) as Role;
      if (!ROLES.includes(role) || !this.activeRoles.has(role)) continue;
      // 与旧模型同一过滤口径：启用且（reviewer/maintainer）配置了 GitLab
      if (!this.context.store.getRoleEnabledProjects(role).some(p => p.id === project.id)) {
        continue;
      }

      const scheduleExpr =
        this.findTriggerSchedule(definition, node.id) ?? DEFAULT_ROLE_SCHEDULES[role];
      if (!validateCron(scheduleExpr)) {
        const message = `项目 ${project.name} 节点 ${node.id} 的 cron 非法: ${scheduleExpr}`;
        logger.error(`[Pipeline] ${message}`);
        recordProjectError(project, new Error(message), 'unknown');
        continue;
      }

      const key = `${project.id}:${node.id}`;
      const task = schedule(scheduleExpr, () => {
        void this.executePipelineBranch(project, definition, node.id, role).catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`[Pipeline] 项目 ${project.name} 节点 ${node.id} 执行失败: ${message}`);
        });
      });
      this.jobs.set(key, { projectId: project.id, role, nodeId: node.id, task });
      logger.info(`[Pipeline] 项目 ${project.name} 节点 ${node.id} 已调度: ${scheduleExpr}`);
    }
  }

  /** 立即执行某项目的角色节点（启动/重启后的对账轮） */
  private async runRoleNow(project: Project, role: Role): Promise<void> {
    const definition = loadProjectPipeline(project);
    const roleNode = definition?.nodes.find(node => node.type === `role.${role}`);
    if (!definition || !roleNode) return;
    await this.executePipelineBranch(project, definition, roleNode.id, role);
  }

  /** 触发器 → 角色节点的下游子图执行 */
  private async executePipelineBranch(
    project: Project,
    definition: PipelineDefinition,
    roleNodeId: string,
    role: Role
  ): Promise<void> {
    const handlers = this.buildNodeHandlers(project, role);
    const executor = new PipelineExecutor(handlers, this.getRunStore());
    const triggerNode = this.findUpstreamTrigger(definition, roleNodeId);
    const startFrom = triggerNode ? [triggerNode.id] : [roleNodeId];
    await executor.execute(definition, this.buildRunContext(project), {
      projectId: project.id,
      startFrom,
    });
  }

  private buildNodeHandlers(project: Project, role: Role): Map<string, NodeHandler> {
    const handlers = new Map<string, NodeHandler>();
    handlers.set('trigger.cron', {
      type: 'trigger.cron',
      outputs: ['tick'],
      run: async () => ({ tick: new Date().toISOString() }),
    });
    handlers.set(`role.${role}`, {
      type: `role.${role}`,
      inputs: ['trigger'],
      run: async () => {
        // 对拍旧版 startProjectLoop 的 agentStarted 状态记录
        recordAgentStarted(project);
        await this.runtime.runOnce(project, role);
        return {};
      },
    });
    return handlers;
  }

  private buildRunContext(project: Project): RunContext {
    return {
      logger: {
        info: msg => logger.info(msg),
        warn: msg => logger.warn(msg),
        error: msg => logger.error(msg),
      },
      services: { project },
      vars: { projectId: project.id },
    };
  }

  private getRunStore(): PipelineRunStore {
    if (!this.runStore) {
      this.runStore = new PipelineRunStore(this.context.store.database);
    }
    return this.runStore;
  }

  /** 找到角色节点上游的 trigger.cron 节点（默认管线为一对一结构） */
  private findUpstreamTrigger(definition: PipelineDefinition, roleNodeId: string) {
    const upstreamIds = new Set(
      definition.edges.filter(edge => edge.to.node === roleNodeId).map(edge => edge.from.node)
    );
    return definition.nodes.find(node => node.type === 'trigger.cron' && upstreamIds.has(node.id));
  }

  /** 角色节点的调度表达式：上游 trigger.cron 的 params.schedule */
  private findTriggerSchedule(
    definition: PipelineDefinition,
    roleNodeId: string
  ): string | undefined {
    const trigger = this.findUpstreamTrigger(definition, roleNodeId);
    const schedule = trigger?.params?.schedule;
    return typeof schedule === 'string' && schedule.trim() !== '' ? schedule : undefined;
  }

  private async waitForMemoryMcpUrl(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (!this.options.mcpUrl) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('等待 EverOS MCP URL 超时，无法启动角色服务');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  private async waitForCodeGraphUrl(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (!this.options.codeGraphUrl) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('等待 CodeGraph Server URL 超时，无法启动角色服务');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
