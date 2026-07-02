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

  it('日志缓冲区只输出完整行，保留未结束片段', () => {
    const service = new EverOSService({ submodulePath: '/tmp/everos' });
    const emitted: string[] = [];

    const remaining = (service as unknown as { flushLogLines(buffer: string, emit: (line: string) => void): string }).flushLogLines(
      '2026-07-02 [info] line-one\n2026-07-02 [info] line-two\nincomplete',
      (line) => emitted.push(line)
    );

    expect(emitted).toEqual([
      '2026-07-02 [info] line-one',
      '2026-07-02 [info] line-two',
    ]);
    expect(remaining).toBe('incomplete');

    // 追加后续内容后，未完成片段应被补全并输出
    const remaining2 = (service as unknown as { flushLogLines(buffer: string, emit: (line: string) => void): string }).flushLogLines(
      `${remaining}-rest\n`,
      (line) => emitted.push(line)
    );

    expect(emitted).toContain('incomplete-rest');
    expect(remaining2).toBe('');
  });
});
