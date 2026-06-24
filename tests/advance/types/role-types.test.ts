import { describe, it, expect } from 'vitest';
import type { Role, ReviewerConfig, MaintainerConfig } from '../../../src/advance/types.js';

describe('Role 类型', () => {
  it('ReviewerConfig 可赋值给 RoleConfig', () => {
    const config: ReviewerConfig = {
      role: 'reviewer',
      enabled: true,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
    };
    expect(config.role).toBe('reviewer');
  });

  it('MaintainerConfig 包含 maintainerName 字段', () => {
    const config: MaintainerConfig = {
      role: 'maintainer',
      enabled: false,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
      maintainerName: 'CodeKeeper Maintainer',
      autoFixEnabled: true,
      resolveOthersDiscussions: true,
    };
    expect(config.maintainerName).toBe('CodeKeeper Maintainer');
  });
});
