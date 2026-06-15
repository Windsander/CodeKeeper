import { describe, it, expect } from 'vitest';
import { SuggestionEngine } from '../../../src/advance/archive/suggestion-engine';
import { LlmClient } from '../../../src/advance/llm/client';

describe('SuggestionEngine', () => {
  it('应解析建议并生成 ArchiveAction', async () => {
    const response = JSON.stringify({
      type: 'move',
      reason: '应放入 docs/specs',
      targetPath: '/docs/specs/a.md',
      risk: 'low',
      confidence: 0.88,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/a.md', '# 内容', {
      category: 'memory',
      docType: 'spec',
      tags: [],
      summary: '摘要',
      confidence: 0.9,
    });
    expect(action.type).toBe('move');
    expect(action.risk).toBe('low');
    expect(action.targetPath).toBe('/docs/specs/a.md');
    expect(action.sourcePath).toBe('/a.md');
  });

  it('解析失败时应回退到 flag', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '无效' } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/x.md', '...', {
      category: 'other',
      docType: 'note',
      tags: [],
      summary: '未知',
      confidence: 0.3,
    });
    expect(action.type).toBe('flag');
    expect(action.risk).toBe('high');
  });

  it('当 LLM 未返回 relatedEntryId 时应使用 context.relatedPath 作为 fallback', async () => {
    const response = JSON.stringify({
      type: 'merge',
      reason: '与已有文档合并',
      targetPath: '/docs/specs/b.md',
      risk: 'low',
      confidence: 0.85,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/b.md', '# 内容', {
      category: 'memory',
      docType: 'spec',
      tags: [],
      summary: '摘要',
      confidence: 0.9,
    }, { relatedPath: '/existing.md' });
    expect(action.type).toBe('merge');
    expect(action.relatedEntryId).toBe('/existing.md');
  });

  it('应正确解析被代码块包裹的 LLM 响应', async () => {
    const response = '```json\n' + JSON.stringify({
      type: 'create',
      reason: '新建归档',
      targetPath: '/docs/new.md',
      risk: 'medium',
      confidence: 0.75,
    }) + '\n```';
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/c.md', '# 内容', {
      category: 'memory',
      docType: 'note',
      tags: [],
      summary: '摘要',
      confidence: 0.8,
    });
    expect(action.type).toBe('create');
    expect(action.targetPath).toBe('/docs/new.md');
  });

  it('应将超出 1.0 的 confidence 截断为 1', async () => {
    const response = JSON.stringify({
      type: 'ignore',
      reason: '无需归档',
      risk: 'low',
      confidence: 1.5,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/d.md', '# 内容', {
      category: 'other',
      docType: 'note',
      tags: [],
      summary: '摘要',
      confidence: 0.5,
    });
    expect(action.confidence).toBe(1);
  });

  it('生成的 id 应为非空 16 位字符串且 createdAt 为大于 0 的有限数字', async () => {
    const response = JSON.stringify({
      type: 'move',
      reason: '移动',
      targetPath: '/docs/e.md',
      risk: 'low',
      confidence: 0.9,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest('/e.md', '# 内容', {
      category: 'memory',
      docType: 'spec',
      tags: [],
      summary: '摘要',
      confidence: 0.9,
    });
    expect(typeof action.id).toBe('string');
    expect(action.id.length).toBe(16);
    expect(action.id).not.toBe('');
    expect(typeof action.createdAt).toBe('number');
    expect(Number.isFinite(action.createdAt)).toBe(true);
    expect(action.createdAt).toBeGreaterThan(0);
  });
});
