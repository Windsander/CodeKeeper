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
    expect(result).toContain('memory');
  });

  it('mock 模式下可模拟异常', async () => {
    const client = new LlmClient({
      apiKey: 'test',
      model: 'test-model',
      mock: { error: new Error('模拟异常') },
    });
    await expect(client.complete('x')).rejects.toThrow('模拟异常');
  });
});
