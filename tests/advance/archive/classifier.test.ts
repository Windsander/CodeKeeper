import { describe, it, expect } from 'vitest';
import { DocumentClassifier } from '../../../src/advance/archive/classifier';
import { LlmClient } from '../../../src/advance/llm/client';

describe('DocumentClassifier', () => {
  it('应解析 mock LLM 返回的 JSON 分类结果', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'spec',
      tags: ['memory', 'sync', 'schema'],
      summary: '记忆模块 schema 设计',
      confidence: 0.92,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { categories: ['memory', 'sync', 'skill'] });
    const result = await classifier.classify('/a.md', '# 记忆模块 schema\n...');
    expect(result.category).toBe('memory');
    expect(result.docType).toBe('spec');
    expect(result.confidence).toBe(0.92);
  });

  it('LLM 返回无效 JSON 时应使用 fallback', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '不是 JSON' } });
    const classifier = new DocumentClassifier(client, { categories: ['memory', 'sync'] });
    const result = await classifier.classify('/x.md', '内容');
    expect(result.category).toBe('other');
    expect(result.confidence).toBeLessThan(1);
  });

  it('应将 category 不在白名单时归一化为 other', async () => {
    const response = JSON.stringify({
      category: 'unknown',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { categories: ['memory', 'sync', 'skill'] });
    const result = await classifier.classify('/x.md', '内容');
    expect(result.category).toBe('other');
  });

  it('应将 docType 不在白名单时归一化为 other', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'illegal-type',
      tags: ['a'],
      summary: '摘要',
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, {
      categories: ['memory'],
      docTypes: ['spec', 'weekly'],
    });
    const result = await classifier.classify('/x.md', '内容');
    expect(result.docType).toBe('other');
  });

  it('应对超出范围的 confidence 做截断', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      confidence: 1.5,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { categories: ['memory', 'sync'] });
    const result = await classifier.classify('/x.md', '内容');
    expect(result.confidence).toBe(1);
  });

  it('categories 为空时应使用默认分类列表', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client);
    const result = await classifier.classify('/x.md', '内容');
    expect(result.category).toBe('memory');
  });

  it('docTypes 为空时应使用默认文档类型列表', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'weekly',
      tags: ['a'],
      summary: '摘要',
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client);
    const result = await classifier.classify('/x.md', '内容');
    expect(result.docType).toBe('weekly');
  });
});
