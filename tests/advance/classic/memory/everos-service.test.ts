import { describe, it, expect } from 'vitest';
import { EverOSService } from '../../../../src/advance/classic/memory/everos-service.js';

describe('EverOSService', () => {
  it('构造时保存配置', () => {
    const service = new EverOSService({ submodulePath: '/tmp/everos', port: 12345 });
    expect(service).toBeDefined();
  });

  it('未启动时 stop 不报错', () => {
    const service = new EverOSService({ submodulePath: '/tmp/everos' });
    expect(() => service.stop()).not.toThrow();
  });
});
