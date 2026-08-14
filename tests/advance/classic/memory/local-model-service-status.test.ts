/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { LocalModelServiceManager } from '../../../../src/advance/classic/memory/local-model-service.js';
import type { ModelServiceStatus } from '../../../../src/electron/shared/service-status.js';

describe('LocalModelServiceManager.getStatus', () => {
  it('聚合 embedding 与 rerank 两个 server 的状态', () => {
    const manager = new LocalModelServiceManager({
      venvDir: 'virtual-model-venv',
      embeddingModel: 'intfloat/multilingual-e5-small',
      rerankModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
    });

    (manager as unknown as { embeddingStatus: ModelServiceStatus }).embeddingStatus = {
      state: 'running',
      url: 'http://127.0.0.1:12345',
      error: null,
      progress: null,
    };
    (manager as unknown as { rerankStatus: ModelServiceStatus }).rerankStatus = {
      state: 'downloading',
      url: null,
      error: null,
      progress: 45,
    };

    const status = manager.getStatus();
    expect(status.embedding.state).toBe('running');
    expect(status.embedding.url).toBe('http://127.0.0.1:12345');
    expect(status.rerank.state).toBe('downloading');
    expect(status.rerank.url).toBeNull();
    expect(status.rerank.progress).toBe(45);
  });

  it('未启动的 server 返回 idle 状态', () => {
    const manager = new LocalModelServiceManager({ venvDir: 'virtual-model-venv' });
    const status = manager.getStatus();
    expect(status.embedding.state).toBe('idle');
    expect(status.rerank.state).toBe('idle');
  });
});
