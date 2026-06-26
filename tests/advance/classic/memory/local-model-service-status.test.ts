/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { LocalModelServiceManager } from '../../../../src/advance/classic/memory/local-model-service.js';
import type { ModelServiceStatus } from '../../../../src/electron/shared/service-status.js';

function fakeServer(status: ModelServiceStatus) {
  return {
    getStatus: () => status,
    url: status.url,
    isHealthy: () => status.state === 'running',
  };
}

describe('LocalModelServiceManager.getStatus', () => {
  it('聚合 embedding 与 rerank 两个 server 的状态', () => {
    const manager = new LocalModelServiceManager({
      venvDir: '/tmp/fake-venv',
      embeddingModel: 'intfloat/multilingual-e5-small',
      rerankModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
    });

    (manager as unknown as { embeddingServer: ReturnType<typeof fakeServer> }).embeddingServer = fakeServer({
      state: 'running',
      url: 'http://127.0.0.1:12345',
      error: null,
    });
    (manager as unknown as { rerankServer: ReturnType<typeof fakeServer> }).rerankServer = fakeServer({
      state: 'downloading',
      url: null,
      error: null,
    });

    const status = manager.getStatus();
    expect(status.embedding.state).toBe('running');
    expect(status.embedding.url).toBe('http://127.0.0.1:12345');
    expect(status.rerank.state).toBe('downloading');
    expect(status.rerank.url).toBeNull();
  });

  it('未启动的 server 返回 idle 状态', () => {
    const manager = new LocalModelServiceManager({ venvDir: '/tmp/fake-venv' });
    const status = manager.getStatus();
    expect(status.embedding.state).toBe('idle');
    expect(status.rerank.state).toBe('idle');
  });
});
