import type {
  ArchiverConfig,
  ArchiverProviderStrategy,
  ArchiverSynthesisPolicy,
} from '../types.js';
import type { ArchiverProviderExecutionStrategy } from './provider-types.js';

export const BUILTIN_ARCHIVER_PROVIDER_ID = 'builtin';
export const DEFAULT_ARCHIVER_PRIMARY_PROVIDER_ID = 'graphify';
export const DEFAULT_ARCHIVER_FALLBACK_PROVIDER_ID = 'codebase-memory-mcp';
export const DEFAULT_ARCHIVER_NAME = 'CodeKeeper Archiver';
export const DEFAULT_ARCHIVER_CRON = '0 2 * * *';
export const ARCHIVER_CONFIG_SCHEMA_VERSION = 3;

/**
 * 创建系统默认 Provider 组合。
 *
 * 该策略只供内部编排器和旧配置迁移使用，不属于项目配置，也不由用户编辑。
 */
export function createDefaultArchiverProviderStrategy(): ArchiverProviderStrategy {
  return {
    sources: [DEFAULT_ARCHIVER_PRIMARY_PROVIDER_ID, DEFAULT_ARCHIVER_FALLBACK_PROVIDER_ID],
    augmenters: [],
    synthesis: {
      provider: BUILTIN_ARCHIVER_PROVIDER_ID,
      policy: 'always',
    },
  };
}

/** 创建不含 Provider 配置的 Archiver 默认配置。 */
export function createDefaultArchiverConfig(): ArchiverConfig {
  return {
    role: 'archiver',
    schemaVersion: ARCHIVER_CONFIG_SCHEMA_VERSION,
    archiverName: DEFAULT_ARCHIVER_NAME,
    automation: {
      enabled: false,
      cron: DEFAULT_ARCHIVER_CRON,
    },
  };
}

/** 对 Provider ID 列表去空、去重并保持原顺序。 */
function normalizeProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 规范化旧 Provider 组合，仅用于兼容旧测试和旧运行态数据。 */
export function normalizeArchiverProviderStrategy(value: unknown): ArchiverProviderStrategy {
  const defaults = createDefaultArchiverProviderStrategy();
  if (!value || typeof value !== 'object') return defaults;

  const raw = value as Record<string, unknown>;
  const synthesisRaw =
    raw.synthesis && typeof raw.synthesis === 'object'
      ? (raw.synthesis as Record<string, unknown>)
      : undefined;
  const synthesisProvider = normalizeText(
    synthesisRaw?.provider,
    defaults.synthesis.provider
  );
  const sources = normalizeProviderIds(raw.sources).filter(id => id !== synthesisProvider);
  const sourceSet = new Set(sources);
  const augmenters = normalizeProviderIds(raw.augmenters).filter(
    id => id !== synthesisProvider && !sourceSet.has(id)
  );

  return {
    sources: Array.isArray(raw.sources) ? sources : [...defaults.sources],
    augmenters: Array.isArray(raw.augmenters) ? augmenters : [...defaults.augmenters],
    synthesis: {
      provider: synthesisProvider,
      policy: normalizeSynthesisPolicy(synthesisRaw?.policy, defaults.synthesis.policy),
    },
  };
}

/**
 * 将旧的静态组合转换为编排器内部协议。
 *
 * 新代码应优先让 Provider Registry 生成自动策略；此函数保留给旧调用方和测试。
 */
export function toArchiverProviderExecutionStrategy(
  value: unknown = createDefaultArchiverProviderStrategy()
): ArchiverProviderExecutionStrategy {
  const knowledge = normalizeArchiverProviderStrategy(value);
  const synthesisProvider = knowledge.synthesis.provider;
  const sources = knowledge.sources.filter(id => id !== synthesisProvider);
  const primary = sources[0] ?? (knowledge.synthesis.policy === 'always' ? synthesisProvider : '');
  const enrichers = [...knowledge.augmenters];
  if (
    knowledge.synthesis.policy === 'always' &&
    sources.length > 0 &&
    !enrichers.includes(synthesisProvider)
  ) {
    enrichers.push(synthesisProvider);
  }

  return {
    schemaVersion: 1,
    primary,
    fallbacks: sources.slice(1),
    enrichers,
    builtinFallback:
      synthesisProvider === BUILTIN_ARCHIVER_PROVIDER_ID &&
      knowledge.synthesis.policy !== 'off',
    overrides: {},
  };
}

/**
 * 规范化数据库或 IPC 中的 Archiver 配置。
 *
 * V1/V2 的 Provider 字段只用于识别旧格式，不会被带入新的持久化结果。
 */
export function normalizeArchiverConfig(value: unknown): ArchiverConfig {
  const defaults = createDefaultArchiverConfig();
  if (!value || typeof value !== 'object') return defaults;

  const raw = value as Record<string, unknown>;
  const automation =
    raw.automation && typeof raw.automation === 'object'
      ? (raw.automation as Record<string, unknown>)
      : {};
  const legacyEnabled = typeof raw.enabled === 'boolean' ? raw.enabled : undefined;
  const legacyCron = typeof raw.reviewSchedule === 'string' ? raw.reviewSchedule : undefined;

  return {
    role: 'archiver',
    schemaVersion: ARCHIVER_CONFIG_SCHEMA_VERSION,
    archiverName: normalizeText(raw.archiverName, defaults.archiverName),
    automation: {
      enabled:
        typeof automation.enabled === 'boolean'
          ? automation.enabled
          : legacyEnabled ?? defaults.automation.enabled,
      cron: normalizeText(
        automation.cron,
        normalizeText(legacyCron, defaults.automation.cron)
      ),
    },
  };
}

function normalizeSynthesisPolicy(
  value: unknown,
  fallback: ArchiverSynthesisPolicy
): ArchiverSynthesisPolicy {
  return value === 'off' || value === 'fallback' || value === 'always' ? value : fallback;
}

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
