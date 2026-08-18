import type { ArchiverConfig, Role } from '../../types.js';
import {
  createDefaultArchiverConfig,
  normalizeArchiverConfig,
} from '../../archiver/provider-config.js';
import { BaseRoleManager } from './base-role-manager.js';

/**
 * Archiver 角色管理器
 * 负责归档/知识整理角色的配置与状态管理
 */
export class ArchiverManager extends BaseRoleManager {
  readonly role: Role = 'archiver';

  async getConfig(projectId: string): Promise<ArchiverConfig> {
    return normalizeArchiverConfig(await super.getConfig(projectId));
  }

  async updateConfig(projectId: string, config: ArchiverConfig): Promise<void> {
    if (config.role !== this.role) {
      throw new Error(`Archiver 配置角色不匹配: ${config.role}`);
    }
    this.store.updateProjectRoleConfig(projectId, this.role, normalizeArchiverConfig(config));
  }

  getDefaultConfig(): ArchiverConfig {
    return createDefaultArchiverConfig();
  }

  getSoulFileName(): string {
    return 'ARCHIVER-SOUL.md';
  }
}
