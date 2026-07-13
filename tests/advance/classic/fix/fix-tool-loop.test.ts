import { describe, it, expect } from 'vitest';
import { FixToolLoop } from '../../../../src/advance/classic/fix/fix-tool-loop.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { ReviewFinding, MergeRequest } from '../../../../src/advance/classic/provider/types.js';
import { ErrorDeltaValidationStrategy } from '../../../../src/advance/classic/fix/validation-strategy.js';

function createMockWorktreeManager(validateResult?: {
  lint: boolean;
  typecheck: boolean;
  lintReason?: string;
  typecheckReason?: string;
}): WorktreeManager {
  return {
    resolveFilePath: async (p: string) => p,
    readFile: () => 'line1\nline2\n',
    writeFile: () => undefined,
    validate: async () => validateResult ?? { lint: true, typecheck: true },
    applyPatch: async () => true,
    runScript: async () => ({ success: true }),
    removeFile: async () => undefined,
  } as unknown as WorktreeManager;
}

function createMockLlmClient(
  toolResponses: Array<{
    content?: string;
    toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
    stopReason?: string;
  }>
): LlmClient {
  return new LlmClient({ apiKey: 'test', mock: { toolResponses } });
}

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test',
  description: '',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  author: 'dev',
  draft: false,
  changesCount: 1,
  createdAt: '',
  updatedAt: '',
  webUrl: '',
};

const mockFinding: ReviewFinding = {
  severity: 'MEDIUM',
  file: 'src/index.ts',
  line: 2,
  message: '问题',
  suggestion: '修改',
  autoFixable: true,
};

describe('FixToolLoop', () => {
  it('多步工具循环完成后返回成功', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        {
          toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'done' } }],
        },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
    expect(loop.getAppliedFiles()).toContain('src/index.ts');
  });

  it('finish 成功但未 validate 返回失败', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        {
          toolCalls: [{ id: '1', name: 'finish', input: { success: true, reason: 'done' } }],
        },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('尚未通过验证策略');
  });

  it('达到 maxSteps 返回失败', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 2,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('最大步数');
  });

  it('content 包含工具调用 JSON 时兜底解析并执行', async () => {
    const loop = new FixToolLoop({
      llmClient: new LlmClient({
        apiKey: 'test',
        mock: {
          toolResponses: [
            { content: '{"name":"write_file","input":{"relPath":"src/index.ts","content":"fixed"}}', toolCalls: [] },
            { content: '{"name":"validate","input":{}}', toolCalls: [] },
            { content: '{"name":"finish","input":{"success":true,"reason":"done"}}', toolCalls: [] },
          ],
        },
      }),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
    expect(loop.getAppliedFiles()).toContain('src/index.ts');
  });
});
