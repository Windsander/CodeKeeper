import type { IpcMain } from 'electron';
import { ReviewerManager } from '../classic/roles/reviewer-manager.js';
import { MaintainerManager } from '../classic/roles/maintainer-manager.js';
import { ArchiverManager } from '../classic/roles/archiver-manager.js';
import type { MetadataStore } from '../store/metadata-store.js';
import type { RoleServiceRegistry } from '../classic/role-service-registry.js';
import type { Role, RoleConfig } from '../types.js';
import type { IRoleManager } from '../classic/roles/role-manager.js';

export interface RoleIPCContext {
  ipc: IpcMain;
  store: MetadataStore;
  serviceRegistry: RoleServiceRegistry;
}

function createRoleManager(role: Role, store: MetadataStore): IRoleManager {
  switch (role) {
    case 'reviewer':
      return new ReviewerManager(store);
    case 'maintainer':
      return new MaintainerManager(store);
    case 'archiver':
      return new ArchiverManager(store);
    default:
      throw new Error(`未支持的角色: ${role}`);
  }
}

export function registerRoleIPCHandlers(context: RoleIPCContext): void {
  const { ipc, store, serviceRegistry } = context;
  const managers = new Map<Role, IRoleManager>();
  const roles: Role[] = ['reviewer', 'maintainer', 'archiver'];

  for (const role of roles) {
    managers.set(role, createRoleManager(role, store));
  }

  ipc.handle(
    'project.role.config.get',
    async (_event, { projectId, role }: { projectId: string; role: Role }) => {
      const manager = managers.get(role);
      if (!manager) throw new Error(`未知角色: ${role}`);
      const config = await manager.getConfig(projectId);
      return { config };
    }
  );

  ipc.handle(
    'project.role.config.update',
    async (
      _event,
      { projectId, role, config }: { projectId: string; role: Role; config: RoleConfig }
    ) => {
      const manager = managers.get(role);
      if (!manager) throw new Error(`未知角色: ${role}`);
      if (!config || config.role !== role) {
        throw new Error(`角色配置不匹配: 请求角色为 ${role}，配置角色为 ${config?.role ?? '缺失'}`);
      }
      await manager.updateConfig(projectId, config);
      // 触发服务重启由后续 task 补齐
      return { success: true };
    }
  );

  ipc.handle(
    'project.role.status.get',
    async (_event, { projectId, role }: { projectId: string; role: Role }) => {
      const manager = managers.get(role);
      if (!manager) throw new Error(`未知角色: ${role}`);
      return manager.getStatus(projectId);
    }
  );

  ipc.handle('role.service.start', async (_event, { role }: { role: Role }) => {
    await serviceRegistry.start(role);
    return { success: true };
  });

  ipc.handle('role.service.stop', async (_event, { role }: { role: Role }) => {
    await serviceRegistry.stop(role);
    return { success: true };
  });

  ipc.handle(
    'role.service.restart',
    async (_event, { role, projectId }: { role: Role; projectId?: string }) => {
      if (projectId) {
        await serviceRegistry.restartProject(role, projectId);
      } else {
        await serviceRegistry.restartProject(role, '');
      }
      return { success: true };
    }
  );

  ipc.handle('role.service.status', async (_event, { role }: { role: Role }) => {
    return serviceRegistry.getStatus(role);
  });
}
