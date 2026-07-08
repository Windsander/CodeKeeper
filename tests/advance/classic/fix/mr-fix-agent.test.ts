import { describe, it, expect, vi } from 'vitest';
import { MrFixAgent } from '../../../../src/advance/classic/fix/mr-fix-agent.js';
import { WorktreeError } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { MergeRequest, ReviewFinding } from '../../../../src/advance/classic/provider/types.js';

function createMockWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    ensureWorktree: vi.fn().mockResolvedValue(undefined),
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    prepareEnvironment: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockReturnValue('line1\nline2\nline3\n'),
    writeFile: vi.fn().mockReturnValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    ...overrides,
  } as unknown as WorktreeManager;
}

function createMockLlmClient(response: string | null): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: { response: response ?? '' },
  });
}

function makePatch(target = 'line2', replacement = 'line2-fixed'): string {
  return `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -2,1 +2,1 @@
-${target}
+${replacement}
`;
}

const mockMR: MergeRequest = {
  iid: 1,
  title: 'Test MR',
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
  severity: 'HIGH',
  file: 'src/index.ts',
  line: 2,
  ruleId: 'RULE-001',
  message: '问题描述',
  suggestion: '修改建议',
  autoFixable: true,
};

describe('MrFixAgent', () => {
  it('应用 LLM 生成的 patch 并推送', async () => {
    const worktree = createMockWorktreeManager();
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(makePatch()),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(true);
    expect(worktree.checkoutBranch).toHaveBeenCalledWith('feature/test');
    expect(worktree.prepareEnvironment).toHaveBeenCalled();
    expect(worktree.writeFile).toHaveBeenCalledWith('src/index.ts', 'line1\nline2-fixed\nline3\n');
    expect(worktree.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringContaining('[CodeKeeper] fix'),
      { setUpstream: false }
    );
  });

  it('校验失败时返回失败', async () => {
    const worktree = createMockWorktreeManager({
      validate: vi.fn().mockResolvedValue({ lint: false, typecheck: true }),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(makePatch()),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('校验未通过');
    expect(worktree.commitAndPush).not.toHaveBeenCalled();
  });

  it('LLM 返回无效 patch 时返回失败', async () => {
    const worktree = createMockWorktreeManager();
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient('fixed content'),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('无法应用 LLM 生成的 patch');
    expect(worktree.writeFile).not.toHaveBeenCalled();
  });

  it('LLM 返回空时返回失败', async () => {
    const worktree = createMockWorktreeManager();
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(null),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('LLM 未生成有效修复 patch');
    expect(worktree.writeFile).not.toHaveBeenCalled();
  });

  it('执行异常时返回失败原因', async () => {
    const worktree = createMockWorktreeManager({
      ensureWorktree: vi.fn().mockRejectedValue(new Error('worktree 异常')),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(makePatch()),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('worktree 异常');
  });

  it('校验失败返回具体原因', async () => {
    const worktree = createMockWorktreeManager({
      validate: vi.fn().mockResolvedValue({
        lint: false,
        typecheck: true,
        lintReason: 'eslint error',
      }),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(makePatch()),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('校验未通过');
    expect(result.reason).toContain('eslint error');
  });

  it('worktree clone 失败返回阶段信息', async () => {
    const worktree = createMockWorktreeManager({
      ensureWorktree: vi.fn().mockRejectedValue(new WorktreeError('clone', new Error('auth failed'))),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(makePatch()),
    });

    const result = await agent.executeFix(mockFinding, mockMR);

    expect(result.success).toBe(false);
    expect(result.reason).toContain('clone');
    expect(result.reason).toContain('auth failed');
  });

  it('跨文件修改按规划逐文件应用 patch', async () => {
    const worktree = createMockWorktreeManager({
      readFile: vi.fn().mockReturnValue('export interface Foo {}\n'),
    });
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(
        JSON.stringify({
          reason: '类型变更需要同步调用点',
          patches: [
            { filePath: 'src/types.ts', description: '给 Foo 添加 error 字段' },
            { filePath: 'src/use.ts', description: '传入 error 参数' },
          ],
        })
      ),
    });

    // 第二次 complete 调用为第二个文件生成 patch；第一次为 plan
    let callCount = 0;
    const planPatch = `diff --git a/src/types.ts b/src/types.ts
--- a/src/types.ts
+++ b/src/types.ts
@@ -1,1 +1,1 @@
-export interface Foo {}
+export interface Foo { error?: number }\n`;
    const usePatch = `diff --git a/src/use.ts b/src/use.ts
--- a/src/use.ts
+++ b/src/use.ts
@@ -1,1 +1,1 @@
-export interface Foo {}
+// use error\n`;
    const llmClient = {
      complete: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return JSON.stringify({
            reason: '类型变更需要同步调用点',
            patches: [
              { filePath: 'src/types.ts', description: '给 Foo 添加 error 字段' },
              { filePath: 'src/use.ts', description: '传入 error 参数' },
            ],
          });
        }
        return callCount === 2 ? planPatch : usePatch;
      }),
    } as unknown as LlmClient;

    const crossFileAgent = new MrFixAgent({ worktreeManager: worktree, llmClient });
    const crossFileFinding: ReviewFinding = {
      ...mockFinding,
      file: 'src/types.ts',
      line: 1,
      message: '接口缺少 error 字段',
      suggestion: '添加 error?: number 并同步调用点',
    };

    const result = await crossFileAgent.executeFix(crossFileFinding, mockMR, { scope: 'cross-file' });

    expect(result.success).toBe(true);
    expect(worktree.writeFile).toHaveBeenCalledWith('src/types.ts', 'export interface Foo { error?: number }\n');
    expect(worktree.writeFile).toHaveBeenCalledWith('src/use.ts', '// use error\n');
  });

  it('deleteFile 为 true 时执行 git rm 并推送', async () => {
    const worktree = createMockWorktreeManager();
    const agent = new MrFixAgent({
      worktreeManager: worktree,
      llmClient: createMockLlmClient(''),
    });

    const result = await agent.executeFix(mockFinding, mockMR, { deleteFile: true });

    expect(result.success).toBe(true);
    expect(worktree.removeFile).toHaveBeenCalledWith('src/index.ts');
    expect(worktree.readFile).not.toHaveBeenCalled();
    expect(worktree.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringContaining('[CodeKeeper] remove'),
      { setUpstream: false }
    );
  });
});
