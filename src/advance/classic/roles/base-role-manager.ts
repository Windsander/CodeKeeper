import type { MetadataStore } from '../../store/metadata-store.js';
import type { RoleConfig, Role, RoleProjectStatus } from '../../types.js';
import { loadProjectStatus } from '../status/project-status-store.js';
import type { IRoleManager } from './role-manager.js';

/**
 * 角色管理器抽象基类
 * 提供通用的配置读取、更新和状态查询逻辑
 */
export abstract class BaseRoleManager implements IRoleManager {
  abstract readonly role: Role;

  constructor(protected store: MetadataStore) {}

  async getConfig(projectId: string): Promise<RoleConfig> {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new Error(`项目不存在: ${projectId}`);
    }
    return project.roles?.[this.role] ?? this.getDefaultConfig();
  }

  async updateConfig(projectId: string, config: RoleConfig): Promise<void> {
    this.store.updateProjectRoleConfig(projectId, this.role, config);
  }

  async getStatus(projectId: string): Promise<RoleProjectStatus> {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new Error(`项目不存在: ${projectId}`);
    }
    return {
      running: false,
      lastRunAt: null,
      ...loadProjectStatus(project),
    };
  }

  abstract getDefaultConfig(): RoleConfig;
  abstract getSoulFileName(): string;
}
