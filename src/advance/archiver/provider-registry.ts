import type {
  ArchiverProviderAdapter,
  ArchiverProviderDescriptor,
  ArchiverProviderExecutionStrategy,
} from './provider-types.js';
import { BuiltinProviderAdapter } from './adapters/builtin-provider-adapter.js';
import { CodebaseMemoryProviderAdapter } from './adapters/codebase-memory-provider-adapter.js';
import { GraphifyProviderAdapter } from './adapters/graphify-provider-adapter.js';
import { RepowiseProviderAdapter } from './adapters/repowise-provider-adapter.js';
import { UnderstandAnythingProviderAdapter } from './adapters/understand-anything-provider-adapter.js';

export class ArchiverProviderRegistry {
  private readonly adapters = new Map<string, ArchiverProviderAdapter>();

  constructor(adapters: ArchiverProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ArchiverProviderAdapter): void {
    this.adapters.set(adapter.descriptor.id, adapter);
  }

  get(providerId: string): ArchiverProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  listDescriptors(): ArchiverProviderDescriptor[] {
    return Array.from(this.adapters.values())
      .map(adapter => adapter.descriptor)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  /**
   * 根据 Provider 能力和系统优先级生成运行时策略。
   *
   * 该结果只存在于当前进程，不写入项目配置；新 Provider 只需声明元数据即可参与遴选。
   */
  createAutomaticStrategy(): ArchiverProviderExecutionStrategy {
    const descriptors = [...this.adapters.values()]
      .map(adapter => adapter.descriptor)
      .filter(descriptor => descriptor.autoSelect !== false);
    const primaryCandidates = descriptors
      .filter(
        descriptor =>
          descriptor.id !== 'builtin' &&
          descriptor.automation !== 'manual' &&
          descriptor.placements.includes('primary')
      )
      .sort(compareSelectionPriority);
    const primaryIds = primaryCandidates.map(descriptor => descriptor.id);
    const enrichers = descriptors
      .filter(
        descriptor =>
          descriptor.placements.includes('enricher') &&
          descriptor.id !== 'builtin' &&
          !primaryIds.includes(descriptor.id)
      )
      .sort(compareSelectionPriority)
      .map(descriptor => descriptor.id);

    return {
      schemaVersion: 1,
      primary: primaryIds[0] ?? 'builtin',
      fallbacks: primaryIds.slice(1),
      enrichers: ['builtin', ...enrichers],
      builtinFallback: true,
      overrides: {},
    };
  }
}

function compareSelectionPriority(
  left: ArchiverProviderDescriptor,
  right: ArchiverProviderDescriptor
): number {
  const priorityDelta = (right.selectionPriority ?? 0) - (left.selectionPriority ?? 0);
  return priorityDelta || left.displayName.localeCompare(right.displayName);
}

export function createDefaultArchiverProviderRegistry(): ArchiverProviderRegistry {
  return new ArchiverProviderRegistry([
    new BuiltinProviderAdapter(),
    new GraphifyProviderAdapter(),
    new CodebaseMemoryProviderAdapter(),
    new RepowiseProviderAdapter(),
    new UnderstandAnythingProviderAdapter(),
  ]);
}
