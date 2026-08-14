import { describe, it, expect, vi } from 'vitest';
import { RoleServiceRegistry } from '../../../src/advance/classic/role-service-registry.js';

describe('RoleServiceRegistry', () => {
  it('可注册 reviewer 和 maintainer 服务', () => {
    const mockStore = {
      getRoleEnabledProjects: vi.fn().mockReturnValue([]),
    };
    const mockContext = { store: mockStore as unknown } as any;
    const registry = new RoleServiceRegistry(mockContext, 'virtual-runner.js');
    registry.register('reviewer');
    registry.register('maintainer');
    expect(registry.getStatus('reviewer')).toEqual({ running: false, enabledProjects: 0, runningProjects: [] });
    expect(registry.getStatus('maintainer')).toEqual({ running: false, enabledProjects: 0, runningProjects: [] });
  });

  it('setMemoryMcpUrl 会回传给已创建的服务实例', () => {
    const mockStore = {
      getRoleEnabledProjects: vi.fn().mockReturnValue([]),
    };
    const mockContext = { store: mockStore as unknown } as any;
    const registry = new RoleServiceRegistry(mockContext, 'virtual-runner.js');
    registry.register('reviewer');
    // getStatus 会懒创建 RoleService 实例
    registry.getStatus('reviewer');
    registry.setMemoryMcpUrl('http://127.0.0.1:65497/mcp');
    registry.setCodeGraphUrl('http://127.0.0.1:65498');
    expect((registry as any).services.get('reviewer').options.mcpUrl).toBe(
      'http://127.0.0.1:65497/mcp'
    );
    expect((registry as any).services.get('reviewer').options.codeGraphUrl).toBe(
      'http://127.0.0.1:65498'
    );
  });
});
