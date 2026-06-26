/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RemoteModelChecker } from '../../../../src/advance/classic/memory/remote-model-checker.js';

describe('RemoteModelChecker', () => {
  const checker = new RemoteModelChecker();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未配置 API Key 返回 unconfigured', async () => {
    const result = await checker.checkLlm({ model: 'claude-opus-4-8' });
    expect(result.state).toBe('unconfigured');
    expect(result.modelLabel).toBe('Opus-4.8');
  });

  it('模型在列表中返回 running', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }] }),
    }));
    const result = await checker.checkLlm({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-opus-4-8',
    });
    expect(result.state).toBe('running');
  });

  it('模型不在列表中返回 error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'other-model' }] }),
    }));
    const result = await checker.checkLlm({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-opus-4-8',
    });
    expect(result.state).toBe('error');
    expect(result.error).toContain('未返回');
  });

  it('网络错误返回 error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const result = await checker.checkLlm({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-opus-4-8',
    });
    expect(result.state).toBe('error');
    expect(result.error).toContain('Network error');
  });
});
