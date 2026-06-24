import { describe, it, expect } from 'vitest';
import { getRoleUI, getAllRoleUIs } from '../../../../src/electron/renderer/roles/role-registry.js';
import '../../../../src/electron/renderer/roles/reviewer-role.js';
import '../../../../src/electron/renderer/roles/maintainer-role.js';

describe('Role UI Registry', () => {
  it('可获取 reviewer UI 配置', () => {
    const ui = getRoleUI('reviewer');
    expect(ui.role).toBe('reviewer');
    expect(ui.displayName).toBe('MR评审');
  });

  it('可获取 maintainer UI 配置', () => {
    const ui = getRoleUI('maintainer');
    expect(ui.role).toBe('maintainer');
    expect(ui.soulFileName).toBe('MAINTAINER-SOUL.md');
  });

  it('getAllRoleUIs 返回两个角色', () => {
    expect(getAllRoleUIs()).toHaveLength(2);
  });
});
