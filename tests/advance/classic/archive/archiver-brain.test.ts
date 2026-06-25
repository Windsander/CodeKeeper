import { describe, it, expect, vi } from 'vitest';
import { ArchiverBrain } from '../../../../src/advance/classic/archive/archiver-brain.js';
import type { Project } from '../../../../src/advance/types.js';

const mockLlmClient = {
  complete: vi.fn(),
} as unknown as import('../../../../src/advance/llm/client.js').LlmClient;

const mockProject: Project = {
  id: 'p1',
  name: 'test-project',
  rootPath: '/tmp/p1',
  registeredAt: Date.now(),
  lastScannedAt: null,
  gitlab: null,
};

describe('ArchiverBrain', () => {
  it('空文件返回空数组', async () => {
    const brain = new ArchiverBrain({ llmClient: mockLlmClient });
    const result = await brain.analyzeProject(mockProject, []);
    expect(result).toEqual([]);
  });

  it('解析 LLM 返回的项目知识', async () => {
    mockLlmClient.complete = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'stack-ts', category: 'stack', sourceFiles: ['package.json'], content: '使用 TypeScript', confidence: 'high' },
    ]));
    const brain = new ArchiverBrain({ llmClient: mockLlmClient });
    const result = await brain.analyzeProject(mockProject, ['package.json', 'src/index.ts']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('stack-ts');
  });
});
