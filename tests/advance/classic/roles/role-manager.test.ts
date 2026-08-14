import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReviewerManager } from '../../../../src/advance/classic/roles/reviewer-manager.js';
import { MaintainerManager } from '../../../../src/advance/classic/roles/maintainer-manager.js';
import { ArchiverManager } from '../../../../src/advance/classic/roles/archiver-manager.js';
import { MetadataStore } from '../../../../src/advance/store/metadata-store.js';
import type { Role, RoleConfig } from '../../../../src/advance/types.js';

describe('RoleManager', () => {
  let store: MetadataStore;
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'role-manager-'));
    store = new MetadataStore(':memory:');
    store.registerProject({
      id: 'p1',
      name: 'proj',
      rootPath: workspace,
      gitlab: null,
      registeredAt: Date.now(),
      lastScannedAt: null,
      roles: {} as Record<Role, RoleConfig>,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(workspace, { recursive: true, force: true });
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

  it('ArchiverManager 返回默认 archiver 配置', async () => {
    const manager = new ArchiverManager(store);
    const config = await manager.getConfig('p1');
    expect(config.role).toBe('archiver');
    expect(config.schemaVersion).toBe(3);
    expect(config.automation.enabled).toBe(false);
    expect(config.automation.cron).toBe('0 2 * * *');
    expect(config).not.toHaveProperty('knowledge');
    expect(config).not.toHaveProperty('providers');
  });

  it('ArchiverManager 将旧配置迁移为零 Provider 配置', async () => {
    store.updateProjectRoleConfig('p1', 'archiver', {
      role: 'archiver',
      enabled: true,
      reviewSchedule: '0 3 * * *',
      learningEnabled: true,
    } as RoleConfig);

    const config = await new ArchiverManager(store).getConfig('p1');

    expect(config.automation.enabled).toBe(true);
    expect(config.automation.cron).toBe('0 3 * * *');
    expect(config.schemaVersion).toBe(3);
    expect(config).not.toHaveProperty('knowledge');
    expect(config).not.toHaveProperty('providers');
  });

  it('ArchiverManager Soul 文件名正确', () => {
    const manager = new ArchiverManager(store);
    expect(manager.getSoulFileName()).toBe('ARCHIVER-SOUL.md');
  });
});
