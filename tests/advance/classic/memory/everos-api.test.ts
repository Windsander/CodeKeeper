import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { everosMemoryAddMessages } from '../../../../src/advance/classic/memory/everos-api.js';

describe('everosMemoryAddMessages retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('遇到 429 时自动重试并在第二次成功', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue('Too many requests'),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    const promise = everosMemoryAddMessages(
      'http://127.0.0.1:8000',
      { appId: 'app', projectId: 'proj', sessionId: 'sess' },
      [{ senderId: 'user', role: 'user', content: 'hello' }]
    );

    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('遇到 500 时重试直到超过最大次数后抛出异常', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal server error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const promise = everosMemoryAddMessages(
      'http://127.0.0.1:8000',
      { appId: 'app', projectId: 'proj', sessionId: 'sess' },
      [{ senderId: 'user', role: 'user', content: 'hello' }]
    );

    const assertion = expect(promise).rejects.toThrow('EverOS 请求失败: 500 Internal server error');
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    // 首次 + 3 次重试
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('遇到 400 时不重试直接抛出异常', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad request'),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      everosMemoryAddMessages(
        'http://127.0.0.1:8000',
        { appId: 'app', projectId: 'proj', sessionId: 'sess' },
        [{ senderId: 'user', role: 'user', content: 'hello' }]
      )
    ).rejects.toThrow('EverOS memory/add 失败: 400 Bad request');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('网络异常时自动重试并在第二次成功', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue('') });
    vi.stubGlobal('fetch', mockFetch);

    const promise = everosMemoryAddMessages(
      'http://127.0.0.1:8000',
      { appId: 'app', projectId: 'proj', sessionId: 'sess' },
      [{ senderId: 'user', role: 'user', content: 'hello' }]
    );

    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
