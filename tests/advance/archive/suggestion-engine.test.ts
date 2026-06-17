import { describe, it, expect } from 'vitest';
import { SuggestionEngine } from '../../../src/advance/archive/suggestion-engine';
import { LlmClient } from '../../../src/advance/llm/client';

const classification = {
  category: 'memory',
  docType: 'spec',
  tags: [],
  summary: '摘要',
  confidence: 0.9,
};

describe('SuggestionEngine', () => {
  it('应解析建议并生成 ArchiveAction', async () => {
    const response = JSON.stringify({
      type: 'copy',
      rationale: '应放入 docs/specs',
      targetPath: '/docs/specs/a.md',
      risk: 'low',
      confidence: 0.88,
      needsReview: false,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/a.md', classification, {
      proposedArchivePath: '/docs/specs/a.md',
    });
    expect(action.type).toBe('copy');
    expect(action.risk).toBe('low');
    expect(action.targetPath).toBe('/docs/specs/a.md');
    expect(action.sourcePath).toBe('/a.md');
  });

  it('解析失败时应回退到 flag', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '无效' } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/x.md', { ...classification, category: 'other', docType: 'note', confidence: 0.3 }, {
      proposedArchivePath: '/other/x.md',
    });
    expect(action.type).toBe('flag');
    expect(action.risk).toBe('high');
  });

  it('应使用 proposedArchivePath 作为 targetPath fallback', async () => {
    const response = JSON.stringify({
      type: 'copy',
      rationale: '归档',
      risk: 'low',
      confidence: 0.85,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/b.md', classification, {
      proposedArchivePath: '/docs/specs/b.md',
      relatedPath: '/existing.md',
    });
    expect(action.type).toBe('copy');
    expect(action.targetPath).toBe('/docs/specs/b.md');
    expect(action.relatedEntryId).toBe('/existing.md');
  });

  it('应正确解析被代码块包裹的 LLM 响应', async () => {
    const response = '```json\n' + JSON.stringify({
      type: 'copy',
      rationale: '复制归档',
      targetPath: '/docs/new.md',
      risk: 'medium',
      confidence: 0.75,
    }) + '\n```';
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/c.md', classification, {
      proposedArchivePath: '/docs/new.md',
    });
    expect(action.type).toBe('copy');
    expect(action.targetPath).toBe('/docs/new.md');
  });

  it('应将超出 1.0 的 confidence 截断为 1', async () => {
    const response = JSON.stringify({
      type: 'ignore',
      rationale: '无需归档',
      risk: 'low',
      confidence: 1.5,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/d.md', { ...classification, category: 'other', docType: 'note', confidence: 0.5 }, {
      proposedArchivePath: '/other/d.md',
    });
    expect(action.confidence).toBe(1);
  });

  it('生成的 id 应为非空 16 位字符串且 createdAt 为大于 0 的有限数字', async () => {
    const response = JSON.stringify({
      type: 'copy',
      rationale: '复制',
      targetPath: '/docs/e.md',
      risk: 'low',
      confidence: 0.9,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/e.md', classification, {
      proposedArchivePath: '/docs/e.md',
    });
    expect(typeof action.id).toBe('string');
    expect(action.id.length).toBe(16);
    expect(action.id).not.toBe('');
    expect(typeof action.createdAt).toBe('number');
    expect(Number.isFinite(action.createdAt)).toBe(true);
    expect(action.createdAt).toBeGreaterThan(0);
  });
});
