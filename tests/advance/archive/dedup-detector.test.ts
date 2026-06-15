import { describe, it, expect } from 'vitest';
import { DedupDetector } from '../../../src/advance/archive/dedup-detector';
import { LlmClient } from '../../../src/advance/llm/client';
import { parseDedupResponse } from '../../../src/advance/llm/prompts/dedup-prompt';

describe('DedupDetector', () => {
  it('应通过哈希快速判定重复', async () => {
    const client = new LlmClient({ apiKey: 'x', mock: { response: '' } });
    const detector = new DedupDetector(client);
    const result = await detector.detect(
      { filePath: '/a.md', contentHash: 'same', content: 'x' },
      [{ filePath: '/b.md', contentHash: 'same', content: 'x' }]
    );
    expect(result.relation).toBe('duplicate');
    expect(result.reason).toContain('哈希');
  });

  it('哈希不同且数量未超限时应调用 LLM', async () => {
    const response = JSON.stringify({ relation: 'related', reason: '主题相近', confidence: 0.8 });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const detector = new DedupDetector(client, { maxCandidates: 3 });
    const result = await detector.detect(
      { filePath: '/a.md', contentHash: 'h1', content: '记忆模块' },
      [{ filePath: '/b.md', contentHash: 'h2', content: '记忆同步' }]
    );
    expect(result.relation).toBe('related');
  });

  it('confidence 低于 threshold 时返回 unrelated', async () => {
    const response = JSON.stringify({ relation: 'duplicate', reason: '内容相同', confidence: 0.3 });
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const detector = new DedupDetector(client);
    const result = await detector.detect(
      { filePath: '/a.md', contentHash: 'h1', content: '记忆模块' },
      [{ filePath: '/b.md', contentHash: 'h2', content: '记忆同步' }]
    );
    expect(result.relation).toBe('unrelated');
  });

  it('parseDedupResponse 对代码块包裹的处理', async () => {
    const response = '```json\n' + JSON.stringify({ relation: 'related', reason: '主题相近', confidence: 0.8 }) + '\n```';
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const detector = new DedupDetector(client);
    const result = await detector.detect(
      { filePath: '/a.md', contentHash: 'h1', content: '记忆模块' },
      [{ filePath: '/b.md', contentHash: 'h2', content: '记忆同步' }]
    );
    expect(result.relation).toBe('related');
  });

  it('非法 JSON 时返回 unrelated', async () => {
    const response = '不是 JSON';
    const client = new LlmClient({ apiKey: 'x', mock: { response } });
    const detector = new DedupDetector(client);
    const result = await detector.detect(
      { filePath: '/a.md', contentHash: 'h1', content: '记忆模块' },
      [{ filePath: '/b.md', contentHash: 'h2', content: '记忆同步' }]
    );
    expect(result.relation).toBe('unrelated');
  });

  it('parseDedupResponse 对 NaN confidence 返回 null', () => {
    // JSON 标准不支持 NaN，这里用字符串拼接构造含 NaN 的 JSON 文本
    const raw = '{"relation":"related","reason":"x","confidence":NaN}';
    const result = parseDedupResponse(raw);
    expect(result).toBeNull();
  });
});
