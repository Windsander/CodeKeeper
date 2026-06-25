import type { ArchiverConfig, Role } from '../../types.js';
import { BaseRoleManager } from './base-role-manager.js';

/**
 * Archiver 角色管理器
 * 负责归档/知识整理角色的配置与状态管理
 */
export class ArchiverManager extends BaseRoleManager {
  readonly role: Role = 'archiver';

  getDefaultConfig(): ArchiverConfig {
    return {
      role: 'archiver',
      enabled: false,
      reviewSchedule: '0 2 * * *',
      learningEnabled: true,
    };
  }

  getSoulFileName(): string {
    return 'ARCHIVER-SOUL.md';
  }
}
