import type {
  ArchiverProviderAdapter,
  ArchiverProviderContextRequest,
  ArchiverProviderContextResult,
  ArchiverProviderDescriptor,
  ArchiverProviderOverride,
  ArchiverProviderProbeResult,
  ArchiverProviderQueryRequest,
  ArchiverProviderQueryResult,
  ArchiverProviderRuntime,
  ArchiverProviderSyncContext,
  ArchiverProviderSyncResult,
} from '../provider-types.js';
import {
  capKnowledgeItems,
  scoreKnowledgeText,
  tokenizeKnowledgeQuery,
} from '../provider-query-utils.js';
import { loadState } from '../../classic/runners/shared/state-utils.js';
import type { ProjectKnowledgeItem } from '../../classic/memory/types.js';

export class BuiltinProviderAdapter implements ArchiverProviderAdapter {
  readonly descriptor: ArchiverProviderDescriptor = {
    id: 'builtin',
    displayName: '内置知识提炼',
    description: '提炼项目文档、约定、领域知识和长期维护风险，写入共享记忆。',
    homepage: '',
    license: 'MIT',
    kind: 'builtin',
    automation: 'full',
    placements: ['primary', 'fallback', 'enricher'],
    capabilities: ['documents', 'query'],
    autoSelect: true,
    selectionPriority: 1000,
  };

  async probe(
    _context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderProbeResult> {
    return {
      providerId: this.descriptor.id,
      available: true,
      readiness: 'ready',
      prepared: true,
      version: 'built-in',
    };
  }

  async sync(
    _context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult> {
    return {
      providerId: this.descriptor.id,
      success: true,
      skipped: true,
      message: '由 Archiver 内置分析阶段执行',
    };
  }

  async loadContext(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    request: ArchiverProviderContextRequest,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderContextResult> {
    const items = this.readKnowledgeItems(context);
    const content = capKnowledgeItems(
      items.map(entry => formatKnowledgeItem(entry.item)),
      items.length || 1,
      request.maxChars ?? 8000
    ).join('\n');
    return {
      providerId: this.descriptor.id,
      success: true,
      content,
      message: content ? undefined : '尚无内置项目知识',
    };
  }

  async query(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    request: ArchiverProviderQueryRequest,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderQueryResult> {
    const tokens = tokenizeKnowledgeQuery(request.query);
    const ranked = this.readKnowledgeItems(context)
      .map(entry => ({
        item: entry.item,
        score: scoreKnowledgeText(
          [entry.item.category, entry.item.content, ...entry.item.sourceFiles].join(' '),
          tokens
        ),
      }))
      .filter(entry => tokens.length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score);
    return {
      providerId: this.descriptor.id,
      success: true,
      items: capKnowledgeItems(
        ranked.map(entry => formatKnowledgeItem(entry.item)),
        request.limit ?? 6,
        request.maxChars ?? 8000
      ),
    };
  }

  async isReady(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<boolean> {
    return this.readKnowledgeItems(context).length > 0;
  }

  private readKnowledgeItems(
    context: ArchiverProviderSyncContext
  ): Array<{ item: ProjectKnowledgeItem; updatedAt: number }> {
    const state = loadState(context.project);
    return Object.values(state.archiverState?.items ?? {}).sort(
      (left, right) => right.updatedAt - left.updatedAt
    );
  }
}

function formatKnowledgeItem(item: ProjectKnowledgeItem): string {
  const sources = item.sourceFiles.length > 0 ? `；来源：${item.sourceFiles.join(', ')}` : '';
  return `- [${item.category}/${item.confidence}] ${item.content}${sources}`;
}
