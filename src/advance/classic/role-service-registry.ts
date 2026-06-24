import type { Role } from '../types.js';

/**
 * 角色服务注册表
 * 管理各角色服务的生命周期（启动、停止、重启、状态查询）
 * 由 Task 7 完整实现，当前为最小化接口占位
 */
export interface RoleServiceRegistry {
  /** 启动指定角色的服务 */
  start(role: Role): void;

  /** 停止指定角色的服务 */
  stop(role: Role): void;

  /** 重启指定角色的服务 */
  restartProject(role: Role, projectId: string): void;

  /** 获取指定角色服务的运行状态 */
  getStatus(role: Role): { running: boolean; projectIds: string[] };
}
