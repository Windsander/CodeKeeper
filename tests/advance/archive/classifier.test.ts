import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentClassifier } from '../../../src/advance/archive/classifier';
import { LlmClient, LlmStructuredOutputError } from '../../../src/advance/llm/client';

describe('DocumentClassifier', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-cls-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeFile(name: string, content: string): string {
    const path = join(tmp, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  it('应解析 mock LLM 返回的 JSON 分类结果', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'spec',
      tags: ['memory', 'sync', 'schema'],
      summary: '记忆模块 schema 设计',
      sections: [],
      confidence: 0.92,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, {
      categories: ['memory', 'sync', 'skill'],
      heuristicThreshold: 1.1, // 强制走 LLM
    });
    const filePath = makeFile('a.md', '# 记忆模块 schema\n...');
    const result = await classifier.classify(filePath, '# 记忆模块 schema\n...');
    expect(result.category).toBe('memory');
    expect(result.docType).toBe('spec');
    expect(result.confidence).toBe(0.92);
    expect(result.sections).toEqual([]);
  });

  it('应解析并保留分节摘要', async () => {
    const response = JSON.stringify({
      category: 'design',
      docType: 'spec',
      tags: ['auth'],
      summary: '认证设计',
      sections: [
        { heading: '背景', summary: '需要统一认证', confidence: 0.9 },
        { heading: '方案', summary: '使用 JWT', confidence: 1.2 },
      ],
      confidence: 0.88,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { heuristicThreshold: 1.1 });
    const filePath = makeFile('auth.md', '# 认证设计\n...');
    const result = await classifier.classify(filePath, '# 认证设计\n...');
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].heading).toBe('背景');
    expect(result.sections[1].confidence).toBe(1);
  });

  it('LLM 未返回 sections 时应回退到空数组', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { heuristicThreshold: 1.1 });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.sections).toEqual([]);
  });

  it('LLM 返回无效 JSON 时应使用 fallback', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '不是 JSON' } });
    const classifier = new DocumentClassifier(client, {
      categories: ['memory', 'sync'],
      heuristicThreshold: 1.1,
    });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.category).toBe('other');
    expect(result.confidence).toBeLessThan(1);
  });

  it('应将 category 不在白名单时归一化为 other', async () => {
    const response = JSON.stringify({
      category: 'unknown',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      sections: [],
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, {
      categories: ['memory', 'sync', 'skill'],
      heuristicThreshold: 1.1,
    });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.category).toBe('other');
  });

  it('应将 docType 不在白名单时归一化为 other', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'illegal-type',
      tags: ['a'],
      summary: '摘要',
      sections: [],
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, {
      categories: ['memory'],
      docTypes: ['spec', 'weekly'],
      heuristicThreshold: 1.1,
    });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.docType).toBe('other');
  });

  it('应对超出范围的 confidence 做截断', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      sections: [],
      confidence: 1.5,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, {
      categories: ['memory', 'sync'],
      heuristicThreshold: 1.1,
    });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.confidence).toBe(1);
  });

  it('categories 为空时应使用默认分类列表', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'note',
      tags: ['a'],
      summary: '摘要',
      sections: [],
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { heuristicThreshold: 1.1 });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.category).toBe('memory');
  });

  it('docTypes 为空时应使用默认文档类型列表', async () => {
    const response = JSON.stringify({
      category: 'memory',
      docType: 'weekly',
      tags: ['a'],
      summary: '摘要',
      sections: [],
      confidence: 0.8,
    });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const classifier = new DocumentClassifier(client, { heuristicThreshold: 1.1 });
    const filePath = makeFile('x.md', '内容');
    const result = await classifier.classify(filePath, '内容');
    expect(result.docType).toBe('weekly');
  });

  it('启发置信度足够高时应跳过 LLM', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '不是 JSON' } });
    const classifier = new DocumentClassifier(client);
    const filePath = makeFile('weekly-2024-01.md', '# 周报');
    const result = await classifier.classify(filePath, '# 周报');
    expect(result.category).toBe('weekly');
    expect(result.docType).toBe('weekly');
  });

  it('应通过 completeJson 请求结构化分类', async () => {
    const complete = vi.fn();
    const completeJson = vi.fn().mockResolvedValue(
      JSON.stringify({
        category: 'memory',
        docType: 'spec',
        tags: ['schema'],
        summary: '结构化分类',
        sections: [],
        confidence: 0.9,
      })
    );
    const client = { complete, completeJson } as unknown as LlmClient;
    const classifier = new DocumentClassifier(client, {
      categories: ['memory'],
      docTypes: ['spec'],
      heuristicThreshold: 1.1,
    });
    const filePath = makeFile('structured.md', '# structured');

    const result = await classifier.classify(filePath, '# structured');

    expect(result.category).toBe('memory');
    expect(completeJson).toHaveBeenCalledOnce();
    expect(completeJson.mock.calls[0][2]).toMatchObject({
      required: ['category', 'docType', 'tags', 'summary', 'sections', 'confidence'],
      additionalProperties: false,
    });
    expect(completeJson.mock.calls[0][0]).not.toContain(tmp);
    expect(completeJson.mock.calls[0][0]).toContain('structured.md');
    expect(complete).not.toHaveBeenCalled();
  });

  it('结构化分类结果缺失时应安全回退', async () => {
    const completeJson = vi
      .fn()
      .mockRejectedValue(new LlmStructuredOutputError('LLM 未返回 JSON 工具调用'));
    const client = { completeJson } as unknown as LlmClient;
    const classifier = new DocumentClassifier(client, { heuristicThreshold: 1.1 });
    const filePath = makeFile('fallback.md', '# fallback');

    const result = await classifier.classify(filePath, '# fallback');

    expect(result).toMatchObject({
      category: 'other',
      docType: 'other',
      confidence: 0,
    });
  });
});
