import type { Role } from '../types.js';
import type { HandlerContext } from '../ipc/handlers.js';
import { RoleService, type RoleServiceOptions, type RoleServiceStatus } from './role-service.js';

/**
 * 角色服务注册表
 * 统一管理多角色服务的生命周期（注册、启动、停止、重启、状态查询）
 */
export class RoleServiceRegistry {
  private services = new Map<Role, RoleService>();
  private registeredRoles = new Set<Role>();
  public context: HandlerContext;

  constructor(
    context: HandlerContext,
    private runnerPath: string,
    private options: RoleServiceOptions = {},
  ) {
    this.context = context;
  }

  /**
   * 注册指定角色的服务
   * @param role 角色标识
   */
  register(role: Role): void {
    this.registeredRoles.add(role);
  }

  /**
   * 启动指定角色的服务
   * 若 Daemon 正在初始化 EverOS，会等待 MCP URL 就绪后再 fork Agent 子进程。
   * @param role 角色标识
   */
  async start(role: Role): Promise<void> {
    await this.waitForMemoryMcpUrl(60000);
    await this.getService(role).start();
  }

  /**
   * 等待 Daemon 设置 EverOS MCP URL，最多等待 timeoutMs 毫秒。
   */
  private async waitForMemoryMcpUrl(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (!this.options.mcpUrl) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('等待 EverOS MCP URL 超时，无法启动角色服务');
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * 停止指定角色的服务
   * @param role 角色标识
   */
  async stop(role: Role): Promise<void> {
    await this.getService(role).stop();
  }

  /**
   * 重启指定角色的服务或指定项目
   * @param role 角色标识
   * @param projectId 项目 ID（可选）
   */
  async restartProject(role: Role, projectId: string): Promise<void> {
    await this.getService(role).restartProject(projectId);
  }

  /**
   * 获取指定角色服务的运行状态
   * @param role 角色标识
   * @returns 角色服务状态
   */
  getStatus(role: Role): RoleServiceStatus {
    return this.getService(role).getStatus();
  }

  /**
   * 设置 EverOS MCP Server URL，供后续懒创建的角色服务使用，
   * 同时回传给已经创建过的服务实例，避免它们因缓存了旧 options 而重复启动 EverOS。
   */
  setMemoryMcpUrl(url: string): void {
    this.options = { ...this.options, mcpUrl: url };
    for (const service of this.services.values()) {
      service.setMcpUrl(url);
    }
  }

  /**
   * 获取已注册的服务实例
   * @param role 角色标识
   * @returns RoleService 实例
   * @throws 若角色未注册则抛出错误
   */
  private getService(role: Role): RoleService {
    let service = this.services.get(role);
    if (!service) {
      if (!this.registeredRoles.has(role)) {
        throw new Error(`角色 ${role} 服务未注册`);
      }
      // 懒创建：确保此时 context 已被回设为完整的 handlerContext
      service = new RoleService(role, this.context, this.runnerPath, this.options);
      this.services.set(role, service);
    }
    return service;
  }
}
