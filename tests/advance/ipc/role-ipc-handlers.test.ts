import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRoleIPCHandlers } from '../../../src/advance/ipc/role-ipc-registry.js';

describe('Role IPC Registry', () => {
  it('可注册 reviewer 和 maintainer 的 IPC handler', () => {
    const registered: string[] = [];
    const mockIpc = {
      handle: (channel: string, handler: unknown) => {
        registered.push(channel);
      },
    };

    registerRoleIPCHandlers({
      ipc: mockIpc as unknown as Electron.IpcMain,
      store: {} as unknown as MetadataStore,
      serviceRegistry: {} as unknown as RoleServiceRegistry,
    });

    expect(registered).toContain('project.role.config.get');
    expect(registered).toContain('project.role.config.update');
    expect(registered).toContain('project.role.status.get');
    expect(registered).toContain('role.service.start');
    expect(registered).toContain('role.service.stop');
    expect(registered).toContain('role.service.restart');
    expect(registered).toContain('role.service.status');
  });
});
