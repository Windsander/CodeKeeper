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
  ModelServer: vi.fn().mockImplementation(({ capability }) => ({
    start: vi.fn().mockResolvedValue(`http://127.0.0.1:8000/${capability}`),
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
    vi.restoreAllMocks();
  });

  it('start 后返回两个本地 URL', async () => {
    const manager = new LocalModelServiceManager({
      venvDir: '/venv',
      embeddingModel: 'intfloat/multilingual-e5-small',
      rerankModel: 'BAAI/bge-reranker-base',
    });
    await manager.start();
    expect(manager.getEmbeddingUrl()).toBe('http://127.0.0.1:8000/embedding');
    expect(manager.getRerankUrl()).toBe('http://127.0.0.1:8000/rerank');
    manager.stop();
  });
});
