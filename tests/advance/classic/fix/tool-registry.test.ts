import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../../src/advance/classic/fix/tools/tool-registry.js';
import { FINISH_TOOL } from '../../../../src/advance/classic/fix/tools/tool-definitions.js';

describe('ToolRegistry', () => {
  it('默认注册全部修复工具', () => {
    const registry = new ToolRegistry();
    expect(registry.has('read_file')).toBe(true);
    expect(registry.has('write_file')).toBe(true);
    expect(registry.has('finish')).toBe(true);
    expect(registry.list().length).toBeGreaterThan(5);
  });

  it('可通过名称查找工具 schema', () => {
    const registry = new ToolRegistry([FINISH_TOOL]);
    const tool = registry.get('finish');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.required).toContain('success');
  });
});
