import { describe, it, expect } from 'vitest';
import { DedupDetector } from '../../../src/advance/archive/dedup-detector';
import { LlmClient } from '../../../src/advance/llm/client';

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
});
