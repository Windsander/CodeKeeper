import { describe, it, expect, vi } from 'vitest';
import { RoleServiceRegistry } from '../../../src/advance/classic/role-service-registry.js';

describe('RoleServiceRegistry', () => {
  it('可注册 reviewer 和 maintainer 服务', () => {
    const mockStore = {
      getRoleEnabledProjects: vi.fn().mockReturnValue([]),
    };
    const mockContext = { store: mockStore as unknown } as any;
    const registry = new RoleServiceRegistry(mockContext, '/fake/runner.js');
    registry.register('reviewer');
    registry.register('maintainer');
    expect(registry.getStatus('reviewer')).toEqual({ running: false, enabledProjects: 0, runningProjects: [] });
    expect(registry.getStatus('maintainer')).toEqual({ running: false, enabledProjects: 0, runningProjects: [] });
  });
});
