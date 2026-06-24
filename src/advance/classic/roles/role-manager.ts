import type { Role, RoleConfig, RoleProjectStatus } from '../../types.js';

/**
 * 角色管理器接口
 * 定义所有角色管理器必须实现的方法
 */
export interface IRoleManager {
  /** 角色标识 */
  readonly role: Role;

  /**
   * 获取指定项目的角色配置
   * @param projectId 项目 ID
   */
  getConfig(projectId: string): Promise<RoleConfig>;

  /**
   * 更新指定项目的角色配置
   * @param projectId 项目 ID
   * @param config 角色配置
   */
  updateConfig(projectId: string, config: RoleConfig): Promise<void>;

  /**
   * 获取指定项目的角色运行状态
   * @param projectId 项目 ID
   */
  getStatus(projectId: string): Promise<RoleProjectStatus>;

  /**
   * 获取默认角色配置
   */
  getDefaultConfig(): RoleConfig;

  /**
   * 获取 Soul 文件名
   */
  getSoulFileName(): string;
}
