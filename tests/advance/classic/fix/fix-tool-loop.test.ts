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

  it('finish 成功但未实际修改任何文件时返回失败', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'validate', input: {} }] },
        {
          toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }],
        },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('未实际修改或删除任何文件');
  });

  it('输出被截断（stopReason=length）时丢弃残缺调用并重试，后续可修复成功', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        // 第一轮：输出被截断，带一个残缺的工具调用
        {
          content: '我先分析一下这个问题然后写入整个文件……（被截断）',
          toolCalls: [{ id: 't1', name: 'write_file', input: {} }],
          stopReason: 'length',
        },
        // 重试后正常完成
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'done' } }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
    expect(loop.getAppliedFiles()).toContain('src/index.ts');
  });

  it('连续截断超过重试上限时返回失败', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { content: '（每次都被截断）', toolCalls: [], stopReason: 'length' },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 10,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('截断');
  });

  it('LLM 纯文字回复未调用工具（stopReason=stop）时提示重试，后续可修复成功', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        // 第一轮：模型只用文字回复，没有工具调用
        { content: '我认为应该删除未使用的变量。', toolCalls: [], stopReason: 'stop' },
        // 重试后正常完成
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'done' } }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
    expect(loop.getAppliedFiles()).toContain('src/index.ts');
  });

  it('连续未调用工具超过重试上限时返回失败并带回复预览', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { content: '我只是随便聊聊不打算干活', toolCalls: [], stopReason: 'stop' },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 10,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('未调用任何工具');
    expect(result.reason).toContain('我只是随便聊聊不打算干活');
  });

  it('write_file unchanged=true 时不视为有效修改', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        {
          toolCalls: [
            { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'line1\nline2\n' } },
          ],
        },
        { toolCalls: [{ id: '2', name: 'validate', input: {} }] },
        {
          toolCalls: [{ id: '3', name: 'finish', input: { success: true, reason: 'done' } }],
        },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('未实际修改或删除任何文件');
    expect(loop.getAppliedFiles()).not.toContain('src/index.ts');
  });
});
