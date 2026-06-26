/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalModelServiceManager } from '../../../../src/advance/classic/memory/local-model-service.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('../../../../src/advance/classic/memory/model-server.js', () => ({
  ModelServer: vi.fn().mockImplementation(({ capability, onStatusChange }) => ({
    start: vi.fn().mockImplementation(async () => {
      const url = `http://127.0.0.1:8000/${capability}`;
      onStatusChange?.({ state: 'running', url, error: null, progress: null });
      return url;
    }),
    stop: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    url: `http://127.0.0.1:8000/${capability}`,
    onExit: vi.fn(),
  })),
  getFreePort: vi.fn().mockResolvedValue(8000),
}));

describe('LocalModelServiceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('start 后聚合 embedding/rerank 运行状态', async () => {
    const manager = new LocalModelServiceManager({
      venvDir: '/venv',
      embeddingModel: 'intfloat/multilingual-e5-small',
      rerankModel: 'BAAI/bge-reranker-base',
    });
    await manager.start();
    const status = manager.getStatus();
    expect(status.embedding.state).toBe('running');
    expect(status.embedding.url).toBe('http://127.0.0.1:8000/embedding');
    expect(status.rerank.state).toBe('running');
    manager.stop();
  });

  it('停止后状态回到 idle', async () => {
    const manager = new LocalModelServiceManager({ venvDir: '/venv' });
    await manager.start();
    manager.stop();
    const status = manager.getStatus();
    expect(status.embedding.state).toBe('idle');
    expect(status.rerank.state).toBe('idle');
  });
});
