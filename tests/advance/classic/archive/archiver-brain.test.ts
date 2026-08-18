import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { ArchiverBrain } from '../../../../src/advance/classic/archive/archiver-brain.js';
import type { Project } from '../../../../src/advance/types.js';

const mockLlmClient = {
  complete: vi.fn(),
} as unknown as import('../../../../src/advance/llm/client.js').LlmClient;

const mockProject: Project = {
  id: 'p1',
  name: 'test-project',
  rootPath: join('virtual-workspace', 'p1'),
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
    mockLlmClient.complete = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          id: 'stack-ts',
          category: 'stack',
          sourceFiles: ['package.json'],
          content: '使用 TypeScript',
          confidence: 'high',
        },
      ])
    );
    const brain = new ArchiverBrain({ llmClient: mockLlmClient });
    const result = await brain.analyzeProject(mockProject, ['package.json', 'src/index.ts']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('stack-ts');
  });

  it('将关键文件正文传给 LLM', async () => {
    const complete = vi.fn().mockResolvedValue('[]');
    const brain = new ArchiverBrain({
      llmClient: {
        complete,
      } as unknown as import('../../../../src/advance/llm/client.js').LlmClient,
    });

    await brain.analyzeProject(mockProject, ['package.json'], {
      'package.json': '{name:virtual-project}',
    });

    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining('{name:virtual-project}'),
      expect.any(String)
    );
  });

  it('LLM 返回非法 JSON 时抛出解析错误', async () => {
    const brain = new ArchiverBrain({
      llmClient: {
        complete: vi.fn().mockResolvedValue('不是 JSON'),
      } as unknown as import('../../../../src/advance/llm/client.js').LlmClient,
    });

    await expect(brain.analyzeProject(mockProject, ['package.json'])).rejects.toThrow(
      'Archiver 知识响应解析失败'
    );
  });
});
