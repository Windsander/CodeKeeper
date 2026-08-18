import { describe, expect, it } from 'vitest';
import {
  createDefaultArchiverConfig,
  createDefaultArchiverProviderStrategy,
  normalizeArchiverConfig,
  normalizeArchiverProviderStrategy,
  toArchiverProviderExecutionStrategy,
} from '../../../src/advance/archiver/provider-config.js';

describe('Archiver Provider Config', () => {
  it('旧 Provider 组合只用于内部策略，不进入 Archiver 配置', () => {
    const strategy = normalizeArchiverProviderStrategy({
      sources: [' graphify ', 'codebase-memory-mcp', 'graphify', 'builtin'],
      augmenters: [' repowise ', 'graphify', 'repowise', 'builtin'],
      synthesis: { provider: ' builtin ', policy: 'fallback' },
    });

    expect(strategy).toEqual({
      sources: ['graphify', 'codebase-memory-mcp'],
      augmenters: ['repowise'],
      synthesis: { provider: 'builtin', policy: 'fallback' },
    });
    expect(toArchiverProviderExecutionStrategy(strategy)).toEqual({
      schemaVersion: 1,
      primary: 'graphify',
      fallbacks: ['codebase-memory-mcp'],
      enrichers: ['repowise'],
      builtinFallback: true,
      overrides: {},
    });
  });

  it('默认 Archiver 配置只包含身份与自动运行设置', () => {
    const config = createDefaultArchiverConfig();

    expect(config).toEqual({
      role: 'archiver',
      schemaVersion: 3,
      archiverName: 'CodeKeeper Archiver',
      automation: { enabled: false, cron: '0 2 * * *' },
    });
    expect(config).not.toHaveProperty('knowledge');
  });

  it('每次返回独立的默认内部策略对象', () => {
    const first = createDefaultArchiverProviderStrategy();
    const second = createDefaultArchiverProviderStrategy();

    first.sources.push('custom-provider');
    first.augmenters.push('custom-enricher');
    first.synthesis.policy = 'off';

    expect(second.sources).toEqual(['graphify', 'codebase-memory-mcp']);
    expect(second.augmenters).toEqual([]);
    expect(second.synthesis).toEqual({ provider: 'builtin', policy: 'always' });
  });

  it('从旧配置迁移时丢弃 Provider 启动与组合字段', () => {
    const config = normalizeArchiverConfig({
      role: 'archiver',
      enabled: true,
      reviewSchedule: '0 3 * * *',
      archiverName: 'Legacy Archiver',
      providers: {
        primary: 'graphify',
        fallbacks: ['codebase-memory-mcp'],
        enrichers: ['builtin'],
        builtinFallback: true,
        overrides: { graphify: { launchPreset: 'uvx' } },
      },
    });

    expect(config).toEqual({
      role: 'archiver',
      schemaVersion: 3,
      archiverName: 'Legacy Archiver',
      automation: { enabled: true, cron: '0 3 * * *' },
    });
    expect(config).not.toHaveProperty('providers');
    expect(config).not.toHaveProperty('knowledge');
  });
});
