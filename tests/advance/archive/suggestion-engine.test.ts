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
    expect(action.entryId).toBe('/a.md');
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
});
