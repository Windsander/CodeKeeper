import type { Role } from '../types.js';
import type { HandlerContext } from '../ipc/handlers.js';
import { RoleService, type RoleServiceStatus } from './role-service.js';

/**
 * 角色服务注册表
 * 统一管理多角色服务的生命周期（注册、启动、停止、重启、状态查询）
 */
export class RoleServiceRegistry {
  private services = new Map<Role, RoleService>();
  public context: HandlerContext;

  constructor(
    context: HandlerContext,
    private runnerPath: string,
  ) {
    this.context = context;
  }

  /**
   * 注册指定角色的服务
   * @param role 角色标识
   */
  register(role: Role): void {
    this.services.set(role, new RoleService(role, this.context, this.runnerPath));
  }

  /**
   * 启动指定角色的服务
   * @param role 角色标识
   */
  start(role: Role): void {
    this.getService(role).start();
  }

  /**
   * 停止指定角色的服务
   * @param role 角色标识
   */
  stop(role: Role): void {
    this.getService(role).stop();
  }

  /**
   * 重启指定角色的服务或指定项目
   * @param role 角色标识
   * @param projectId 项目 ID（可选）
   */
  restartProject(role: Role, projectId: string): void {
    this.getService(role).restartProject(projectId);
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
   * 获取已注册的服务实例
   * @param role 角色标识
   * @returns RoleService 实例
   * @throws 若角色未注册则抛出错误
   */
  private getService(role: Role): RoleService {
    const service = this.services.get(role);
    if (!service) throw new Error(`角色 ${role} 服务未注册`);
    return service;
  }
}
