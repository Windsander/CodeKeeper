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
import { readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
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
  GENERATED_PIPELINE_MARKER,
  getPipelineDefinitionPath,
  loadProjectPipeline,
} from './default-pipeline.js';
import { pipelineDefinitionSchema, PipelineDefinitionError } from './core/types.js';
import { topoSort } from './core/topology.js';
import { RoleNodeRuntime } from '../classic/role-node-runtime.js';
import { AgentRegistry } from '../agents/registry.js';
import type { TaskEnvelope } from '../agents/task-envelope.js';

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

  /**
   * 读取项目管线（画布用）：不存在时先生成默认管线。
   * generated=true 表示正本仍是自动投影（画布保存后转人类正本）。
   */
  getProjectPipeline(projectId: string): {
    exists: boolean;
    generated: boolean;
    definition: PipelineDefinition | null;
  } {
    const project = this.context.store.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    ensurePipelineDefinition(project);

    const filePath = getPipelineDefinitionPath(project);
    let exists = false;
    let generated = false;
    try {
      const head = readFileSync(filePath, 'utf-8').slice(0, 200);
      exists = true;
      generated = head.startsWith(GENERATED_PIPELINE_MARKER);
    } catch {
      // 文件不存在：项目无启用角色
    }
    return { exists, generated, definition: loadProjectPipeline(project) };
  }

  /**
   * 画布写回：校验通过后覆盖 pipeline.yaml（不带生成标记，转人类正本），
   * 并立即热加载（重排触发器 + 重启节点实例）。
   */
  updateProjectPipeline(projectId: string, definition: unknown): void {
    const project = this.context.store.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);

    const parsed = pipelineDefinitionSchema.parse(definition);
    topoSort(parsed); // 结构校验 + 环检测，非法时抛出
    assertNoSecretParams(parsed);

    writeFileSync(getPipelineDefinitionPath(project), stringify(parsed), 'utf-8');
    this.reloadProject(projectId);
    logger.info(`[Pipeline] 项目 ${project.name} 管线定义已由画布更新`);
  }

  /** 项目的最近运行记录（画布运行状态叠加用；收窄为传输形状，剥离定义与产物） */
  listPipelineRuns(
    projectId: string,
    limit = 20
  ): Array<{
    id: string;
    status: string;
    error: string | null;
    createdAt: number;
    finishedAt: number | null;
    stages: Array<{
      nodeId: string;
      status: string;
      error: string | null;
      startedAt: number;
      finishedAt: number | null;
    }>;
  }> {
    return this.getRunStore()
      .listRunsByProject(projectId, limit)
      .map(run => ({
        id: run.id,
        status: run.status,
        error: run.error,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        stages: this.getRunStore()
          .getStageRuns(run.id)
          .map(stage => ({
            nodeId: stage.nodeId,
            status: stage.status,
            error: stage.error,
            startedAt: stage.startedAt,
            finishedAt: stage.finishedAt,
          })),
      }));
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

  /** 手动触发某项目的角色节点立即执行（MCP 门面 / 未来 UI 按钮用） */
  async runProjectRoleNow(projectId: string, role: Role): Promise<void> {
    const project = this.context.store.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    ensurePipelineDefinition(project);
    await this.runRoleNow(project, role);
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
    const handlers = this.buildNodeHandlers(project, role, definition);
    const executor = new PipelineExecutor(handlers, this.getRunStore());
    const triggerNode = this.findUpstreamTrigger(definition, roleNodeId);
    const startFrom = triggerNode ? [triggerNode.id] : [roleNodeId];
    await executor.execute(definition, this.buildRunContext(project), {
      projectId: project.id,
      startFrom,
    });
  }

  private buildNodeHandlers(
    project: Project,
    role: Role,
    definition?: PipelineDefinition
  ): Map<string, NodeHandler> {
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

    // 外部 Agent 节点：经注册表解析传输适配器，任务信封交互
    if (definition) {
      const registry = new AgentRegistry(this.context.getDaemonConfig?.().agents ?? []);
      for (const node of definition.nodes) {
        if (!node.type.startsWith('agent.') || handlers.has(node.type)) continue;
        handlers.set(node.type, {
          type: node.type,
          run: async (ctx, inputs, params, currentNode) => {
            const transport = registry.resolveTransport(node.type, params);
            const capability =
              typeof params.capability === 'string' ? params.capability : node.type;
            const envelope: TaskEnvelope = {
              id: `${ctx.vars.runId ?? 'run'}:${currentNode.id}`,
              capability,
              input: inputs,
              artifacts: Object.entries(inputs).map(([name, value]) => ({
                name,
                type: 'PipelineArtifact',
                content: typeof value === 'string' ? value : JSON.stringify(value),
              })),
              timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
            };
            const result = await transport.execute(envelope);
            if (result.status === 'failed') {
              throw new Error(`外部 Agent 执行失败: ${result.error ?? '未知错误'}`);
            }
            return result.output;
          },
        });
      }
    }
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

/** 疑似凭据的 params 键名（params 明文落库，凭据只允许经 services 注入） */
const SECRET_PARAM_KEYS = new Set([
  'token',
  'apikey',
  'api_key',
  'secret',
  'password',
  'authorization',
]);

/** 拒绝把疑似凭据写进管线定义（画布与手编 YAML 同一约束） */
function assertNoSecretParams(definition: PipelineDefinition): void {
  for (const node of definition.nodes) {
    for (const key of Object.keys(node.params)) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if (SECRET_PARAM_KEYS.has(normalized) || normalized.endsWith('token')) {
        throw new PipelineDefinitionError(
          `节点 ${node.id} 的 params 含疑似凭据键 "${key}"；凭据只允许经服务注入，不得写入管线定义`
        );
      }
    }
  }
}
