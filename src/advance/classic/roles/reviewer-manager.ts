import type { ReviewerConfig, Role } from '../../types.js';
import { BaseRoleManager } from './base-role-manager.js';

/**
 * Reviewer 角色管理器
 * 负责 MR 评审角色的配置与状态管理
 */
export class ReviewerManager extends BaseRoleManager {
  readonly role: Role = 'reviewer';

  getDefaultConfig(): ReviewerConfig {
    return {
      role: 'reviewer',
      enabled: false,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
    };
  }

  getSoulFileName(): string {
    return 'MR-REVIEWER-SOUL.md';
  }
}
