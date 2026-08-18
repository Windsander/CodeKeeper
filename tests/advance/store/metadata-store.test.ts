import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import type {
  Role,
  RoleConfig,
  ReviewerConfig,
  MaintainerConfig,
} from '../../../src/advance/types';
import { createDefaultArchiverConfig } from '../../../src/advance/archiver/provider-config';

describe('MetadataStore roles 配置', () => {
  let store: MetadataStore;

  beforeEach(() => {
    store = new MetadataStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('保存并读取 reviewer 配置', () => {
    store.registerProject({
      id: 'p1',
      name: 'proj',
      rootPath: join('virtual-workspace', 'p1'),
      registeredAt: 1,
      lastScannedAt: null,
      gitlab: null,
      roles: {} as Record<Role, RoleConfig>,
    });
    const reviewerConfig: ReviewerConfig = {
      role: 'reviewer',
      enabled: true,
      reviewSchedule: '*/5 * * * *',
      learningEnabled: true,
    };
    store.updateProjectRoleConfig('p1', 'reviewer', reviewerConfig);
    const project = store.getProject('p1');
    expect(project.roles.reviewer).toEqual(reviewerConfig);
  });

  it('保存并读取 maintainer 配置', () => {
    store.registerProject({
      id: 'p1',
      name: 'proj',
      rootPath: join('virtual-workspace', 'p1'),
      registeredAt: 1,
      lastScannedAt: null,
      gitlab: null,
      roles: {} as Record<Role, RoleConfig>,
    });
    const maintainerConfig: MaintainerConfig = {
      role: 'maintainer',
      enabled: false,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
      maintainerName: 'Maintainer Bot',
      autoFixEnabled: true,
      resolveOthersDiscussions: false,
    };
    store.updateProjectRoleConfig('p1', 'maintainer', maintainerConfig);
    const project = store.getProject('p1');
    expect(project.roles.maintainer).toEqual(maintainerConfig);
  });

  it('按角色筛选启用项目', () => {
    store.registerProject({
      id: 'p1',
      name: 'proj',
      rootPath: join('virtual-workspace', 'p1'),
      registeredAt: 1,
      lastScannedAt: null,
      gitlab: { baseUrl: 'https://gitlab.example.com', projectPath: 'group/proj', token: 'tok' },
      roles: {} as Record<Role, RoleConfig>,
    });
    store.updateProjectRoleConfig('p1', 'reviewer', {
      role: 'reviewer',
      enabled: true,
      reviewSchedule: '*/5 * * * *',
      learningEnabled: true,
    });
    store.updateProjectRoleConfig('p1', 'maintainer', {
      role: 'maintainer',
      enabled: false,
      reviewSchedule: '*/10 * * * *',
      learningEnabled: true,
      maintainerName: 'x',
      autoFixEnabled: true,
      resolveOthersDiscussions: true,
    });

    const reviewerProjects = store.getRoleEnabledProjects('reviewer');
    const maintainerProjects = store.getRoleEnabledProjects('maintainer');

    expect(reviewerProjects).toHaveLength(1);
    expect(maintainerProjects).toHaveLength(0);
  });

  it('Archiver 可筛选无 GitLab 的本地项目', () => {
    store.registerProject({
      id: 'archiver-project',
      name: 'local-project',
      rootPath: 'virtual-workspace/local-project',
      registeredAt: 1,
      lastScannedAt: null,
      gitlab: null,
      roles: {} as Record<Role, RoleConfig>,
    });
    store.updateProjectRoleConfig('archiver-project', 'archiver', {
      ...createDefaultArchiverConfig(),
      automation: {
        ...createDefaultArchiverConfig().automation,
        enabled: true,
      },
    });

    const archiverProjects = store.getRoleEnabledProjects('archiver');

    expect(archiverProjects.map(project => project.id)).toEqual(['archiver-project']);
  });
});
