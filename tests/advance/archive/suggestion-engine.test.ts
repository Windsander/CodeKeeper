import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { SuggestionEngine } from '../../../src/advance/archive/suggestion-engine';
import { LlmClient } from '../../../src/advance/llm/client';

const classification = {
  category: 'memory',
  docType: 'spec',
  tags: [],
  summary: '摘要',
  confidence: 0.9,
};

function virtualSource(name: string): string {
  return join('virtual-project', name);
}

function virtualArchive(name: string): string {
  return join('virtual-archive', 'docs', 'specs', name);
}

describe('SuggestionEngine', () => {
  it('应解析建议并生成 ArchiveAction', async () => {
    const response = JSON.stringify({
      type: 'copy',
      rationale: '应放入 docs/specs',
      targetPath: virtualArchive('model-selected.md'),
      risk: 'low',
      confidence: 0.88,
      needsReview: false,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest(virtualSource('a.md'), classification, {
      proposedArchivePath: virtualArchive('a.md'),
    });
    expect(action.type).toBe('copy');
    expect(action.risk).toBe('low');
    expect(action.targetPath).toBe(virtualArchive('a.md'));
    expect(action.sourcePath).toBe(virtualSource('a.md'));
  });

  it('解析失败时应回退到 flag', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '无效' } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest(
      virtualSource('x.md'),
      { ...classification, category: 'other', docType: 'note', confidence: 0.3 },
      {
        proposedArchivePath: virtualArchive('x.md'),
      }
    );
    expect(action.type).toBe('flag');
    expect(action.risk).toBe('high');
    expect(action.targetPath).toBe(join('virtual-archive', 'docs', 'specs', 'flagged', 'x.md'));
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
    const action = await engine.suggest(virtualSource('b.md'), classification, {
      proposedArchivePath: virtualArchive('b.md'),
      relatedPath: virtualArchive('existing.md'),
    });
    expect(action.type).toBe('copy');
    expect(action.targetPath).toBe(virtualArchive('b.md'));
    expect(action.relatedEntryId).toBe(virtualArchive('existing.md'));
  });

  it('应正确解析被代码块包裹的 LLM 响应', async () => {
    const response =
      '```json\n' +
      JSON.stringify({
        type: 'copy',
        rationale: '复制归档',
        risk: 'medium',
        confidence: 0.75,
      }) +
      '\n```';
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest(virtualSource('c.md'), classification, {
      proposedArchivePath: virtualArchive('c.md'),
    });
    expect(action.type).toBe('copy');
    expect(action.targetPath).toBe(virtualArchive('c.md'));
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
    const action = await engine.suggest(
      virtualSource('d.md'),
      { ...classification, category: 'other', docType: 'note', confidence: 0.5 },
      {
        proposedArchivePath: virtualArchive('d.md'),
      }
    );
    expect(action.confidence).toBe(1);
  });

  it('生成的 id 应为非空 16 位字符串且 createdAt 为大于 0 的有限数字', async () => {
    const response = JSON.stringify({
      type: 'copy',
      rationale: '复制',
      risk: 'low',
      confidence: 0.9,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);
    const action = await engine.suggest(virtualSource('e.md'), classification, {
      proposedArchivePath: virtualArchive('e.md'),
    });
    expect(typeof action.id).toBe('string');
    expect(action.id.length).toBe(16);
    expect(action.id).not.toBe('');
    expect(typeof action.createdAt).toBe('number');
    expect(Number.isFinite(action.createdAt)).toBe(true);
    expect(action.createdAt).toBeGreaterThan(0);
  });

  it('应通过 completeJson 请求结构化建议', async () => {
    const complete = vi.fn();
    const completeJson = vi.fn().mockResolvedValue(
      JSON.stringify({
        type: 'copy',
        rationale: '归档',
        risk: 'low',
        confidence: 0.9,
        needsReview: false,
      })
    );
    const client = { complete, completeJson } as unknown as LlmClient;
    const engine = new SuggestionEngine(client);

    await engine.suggest(virtualSource('structured.md'), classification, {
      proposedArchivePath: virtualArchive('structured.md'),
    });

    expect(completeJson).toHaveBeenCalledOnce();
    expect(completeJson.mock.calls[0][2]).toMatchObject({
      required: ['type', 'rationale', 'risk', 'confidence', 'needsReview'],
      additionalProperties: false,
    });
    expect(completeJson.mock.calls[0][0]).not.toContain('virtual-archive');
    expect(completeJson.mock.calls[0][0]).toContain('structured.md');
    expect(complete).not.toHaveBeenCalled();
  });

  it('分类已失败时应直接进入 flagged 且不再次调用 LLM', async () => {
    const completeJson = vi.fn();
    const client = { completeJson } as unknown as LlmClient;
    const engine = new SuggestionEngine(client);

    const action = await engine.suggest(
      virtualSource('unclassified.md'),
      {
        ...classification,
        category: 'other',
        docType: 'other',
        summary: '自动分类失败，等待人工 review',
        confidence: 0,
      },
      { proposedArchivePath: virtualArchive('unclassified.md') }
    );

    expect(completeJson).not.toHaveBeenCalled();
    expect(action.type).toBe('flag');
    expect(action.targetPath).toBe(
      join('virtual-archive', 'docs', 'specs', 'flagged', 'unclassified.md')
    );
  });

  it('needsReview 应强制进入程序计算的 flagged 路径', async () => {
    const response = JSON.stringify({
      type: 'copy',
      rationale: '分类仍有歧义',
      targetPath: virtualArchive('untrusted.md'),
      risk: 'medium',
      confidence: 0.6,
      needsReview: true,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const engine = new SuggestionEngine(client);

    const action = await engine.suggest(virtualSource('review.md'), classification, {
      proposedArchivePath: virtualArchive('review.md'),
    });

    expect(action.type).toBe('flag');
    expect(action.targetPath).toBe(
      join('virtual-archive', 'docs', 'specs', 'flagged', 'review.md')
    );
  });
});
