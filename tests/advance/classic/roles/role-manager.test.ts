import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewerManager } from '../../../../src/advance/classic/roles/reviewer-manager.js';
import { MaintainerManager } from '../../../../src/advance/classic/roles/maintainer-manager.js';
import { MetadataStore } from '../../../../src/advance/store/metadata-store.js';
import type { Role, RoleConfig } from '../../../../src/advance/types.js';

describe('RoleManager', () => {
  let store: MetadataStore;

  beforeEach(() => {
    store = new MetadataStore(':memory:');
    store.registerProject({ id: 'p1', name: 'proj', rootPath: '/tmp/p1', gitlab: null, registeredAt: Date.now(), lastScannedAt: null, roles: {} as Record<Role, RoleConfig> });
  });

  it('ReviewerManager 返回默认 reviewer 配置', async () => {
    const manager = new ReviewerManager(store);
    const config = await manager.getConfig('p1');
    expect(config.role).toBe('reviewer');
    expect(config.enabled).toBe(false);
  });

  it('MaintainerManager 返回 maintainer 配置并包含 maintainerName', async () => {
    const manager = new MaintainerManager(store);
    const config = await manager.getConfig('p1');
    expect(config.role).toBe('maintainer');
    expect(config.maintainerName).toBe('CodeKeeper Maintainer');
  });

  it('MaintainerManager Soul 文件名正确', () => {
    const manager = new MaintainerManager(store);
    expect(manager.getSoulFileName()).toBe('MAINTAINER-SOUL.md');
  });
});
