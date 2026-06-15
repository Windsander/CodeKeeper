import { describe, it, expect } from 'vitest';
import { LlmClient } from '../../../src/advance/llm/client';

describe('LlmClient', () => {
  it('mock 模式直接返回预设结果', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      model: 'test-model',
      mock: { response: '{"category":"memory","docType":"spec","tags":["a"],"summary":"测试","confidence":0.9}' },
    });
    const result = await client.complete(' classify this');
    expect(result).toBe('{"category":"memory","docType":"spec","tags":["a"],"summary":"测试","confidence":0.9}');
  });

  it('mock 模式下可模拟异常', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      model: 'test-model',
      mock: { error: new Error('模拟异常') },
    });
    await expect(client.complete('x')).rejects.toThrow('模拟异常');
  });

  it('mock 模式 responses 按顺序循环返回', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      model: 'test-model',
      mock: { responses: ['first', 'second', 'third'] },
    });
    expect(await client.complete('a')).toBe('first');
    expect(await client.complete('b')).toBe('second');
    expect(await client.complete('c')).toBe('third');
    expect(await client.complete('d')).toBe('first');
    expect(await client.complete('e')).toBe('second');
  });
});
