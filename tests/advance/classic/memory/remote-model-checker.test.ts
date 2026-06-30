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
    expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
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

  it('自定义 Headers 覆盖默认 auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await checker.checkLlm({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-opus-4-8',
      headers: { 'x-api-key': 'override-key', 'x-custom': 'value' },
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toMatchObject({
      'x-api-key': 'override-key',
      'anthropic-version': '2023-06-01',
      'x-custom': 'value',
    });
  });

  it('OpenAI 使用 Bearer Token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await checker.checkLlm({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(options.headers['x-api-key']).toBeUndefined();
  });

  it('官方域名未带 /v1 时自动补全', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checker.checkLlm({
      provider: 'anthropic',
      apiKey: 'test-key',
      apiUrl: 'https://api.anthropic.com',
      model: 'claude-opus-4-8',
    });

    expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
  });

  it('apiUrl 包含 /v1/chat/completions 等已知后缀时自动清理', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checker.checkLlm({
      provider: 'openai',
      apiKey: 'test-key',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o-mini',
    });

    expect(result.baseUrl).toBe('https://api.example.com/v1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
  });

  it('/v1/models 返回 400/404/405 时降级探测基地址，可达则视为 running', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD' || init?.method === 'GET') {
        return { ok: true, status: 200 };
      }
      return {
        ok: false,
        status: 400,
        text: async () => '{"error":{"code":"400","message":"Invalid request","param":"404 NOT_FOUND"}}',
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checker.checkLlm({
      provider: 'openai',
      apiKey: 'test-key',
      apiUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
    });

    expect(result.state).toBe('running');
    expect(result.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1', expect.objectContaining({ method: 'HEAD' }));
  });

  it('服务端 5xx 返回 error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal server error',
    }));
    const result = await checker.checkLlm({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-opus-4-8',
    });
    expect(result.state).toBe('error');
    expect(result.error).toContain('HTTP 500');
  });

  it('多模态配置解析自定义 Headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-sonnet-4-6' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await checker.checkMultimodal({
      multimodalProvider: 'anthropic',
      multimodalApiKey: 'mm-key',
      multimodalBaseUrl: 'https://api.anthropic.com/v1',
      multimodalModel: 'claude-sonnet-4-6',
      multimodalHeaders: JSON.stringify({ 'x-custom': 'mm-value' }),
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toMatchObject({
      'x-api-key': 'mm-key',
      'anthropic-version': '2023-06-01',
      'x-custom': 'mm-value',
    });
  });
});
