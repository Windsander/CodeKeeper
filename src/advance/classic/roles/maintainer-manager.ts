import type { MaintainerConfig, Role } from '../../types.js';
import { BaseRoleManager } from './base-role-manager.js';

/**
 * Maintainer 角色管理器
 * 负责代码维护角色的配置与状态管理
 */
export class MaintainerManager extends BaseRoleManager {
  readonly role: Role = 'maintainer';

  getDefaultConfig(): MaintainerConfig {
    return {
      role: 'maintainer',
      enabled: false,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
      maintainerName: 'CodeKeeper Maintainer',
      autoFixEnabled: true,
      resolveOthersDiscussions: true,
    };
  }

  getSoulFileName(): string {
    return 'MAINTAINER-SOUL.md';
  }
}
