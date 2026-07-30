import { describe, it, expect } from 'vitest';
import { FixToolLoop } from '../../../../src/advance/classic/fix/fix-tool-loop.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import { defaultPromptLoader } from '../../../../src/advance/llm/prompts/loader.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type {
  ReviewFinding,
  MergeRequest,
} from '../../../../src/advance/classic/provider/types.js';
import type { FocusedContext } from '../../../../src/advance/classic/fix/focused-context-builder.js';
import { ErrorDeltaValidationStrategy } from '../../../../src/advance/classic/fix/validation-strategy.js';
import { mockOf } from '../../../helpers/mock-of.js';

function createMockWorktreeManager(validateResult?: {
  lint: boolean;
  typecheck: boolean;
  lintReason?: string;
  typecheckReason?: string;
}): WorktreeManager {
  return mockOf<WorktreeManager>({
    getWorktreePath: () => '/tmp/fix-tool-loop-test-worktree',
    resolveFilePath: async (p: string) => p,
    readFile: () => 'line1\nline2\n',
    readFileRange: async (_p: string, start: number, end: number) => `lines ${start}-${end}\n`,
    readFileWindow: async (_p: string, finding: ReviewFinding): Promise<FocusedContext> => ({
      imports: '',
      snippet: `around line ${finding.line}\n`,
      snippetStartLine: finding.line,
      snippetEndLine: finding.line + 1,
      totalLines: 100,
      truncated: false,
      targetLine: finding.line,
    }),
    writeFile: () => undefined,
    validate: async () => validateResult ?? { lint: true, typecheck: true },
    applyPatch: async () => true,
    searchInFile: async () => [],
    getFileOverview: async () => ({ lineCount: 2, symbols: [] }),
    runScript: async () => ({ success: true }),
    removeFile: async () => undefined,
  });
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
        {
          toolCalls: [
            { id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
          ],
        },
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

  it('finish 成功但未 validate 时自动验证，无文件变更仍返回失败', async () => {
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
    expect(result.reason).toContain('未实际修改或删除任何文件');
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

  it('连续多步无进展时提前终止，避免耗尽 maxSteps', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '4', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '5', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '6', name: 'validate', input: {} }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('修复陷入循环');
  });

  it('连续无进展后回查发现已修复时返回成功且不要求文件变更', async () => {
    const recheckAlreadyFixed = vi.fn().mockResolvedValue({
      alreadyFixed: true,
      reason: '当前完整文件中问题已经消失',
      evidence: '默认 sink 的未注入路径已有测试覆盖',
    });
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '4', name: 'validate', input: {} }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
      maxStepsWithoutProgress: 3,
      recheckAlreadyFixed,
    });

    const result = await loop.run();

    expect(recheckAlreadyFixed).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      alreadyFixed: true,
      reason: '当前完整文件中问题已经消失',
      evidence: '默认 sink 的未注入路径已有测试覆盖',
    });
    expect(loop.getAppliedFiles()).toEqual([]);
  });

  it('读取同一文件的不同窗口视为有进展，不因 5 步无进展早退', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        {
          toolCalls: [
            {
              id: '1',
              name: 'read_file',
              input: { relPath: 'src/index.ts', startLine: 1, endLine: 80 },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: '2',
              name: 'read_file',
              input: { relPath: 'src/index.ts', startLine: 81, endLine: 160 },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: '3',
              name: 'read_file',
              input: { relPath: 'src/index.ts', startLine: 161, endLine: 240 },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: '4',
              name: 'read_file',
              input: { relPath: 'src/index.ts', startLine: 241, endLine: 320 },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: '5',
              name: 'read_file',
              input: { relPath: 'src/index.ts', startLine: 321, endLine: 400 },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: '6',
              name: 'read_file',
              input: { relPath: 'src/index.ts', startLine: 401, endLine: 480 },
            },
          ],
        },
        {
          toolCalls: [
            { id: '7', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
          ],
        },
        { toolCalls: [{ id: '8', name: 'finish', input: { success: true, reason: 'done' } }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
  });

  it('只读探索达到上限后重新回查 already-fixed', async () => {
    const recheckAlreadyFixed = vi.fn().mockResolvedValue({
      alreadyFixed: true,
      reason: '当前代码已经满足 Reviewer 要求',
      evidence: '已有提交包含实例级生命周期保护',
    });
    const readResponses = Array.from({ length: 8 }, (_, index) => ({
      toolCalls: [
        {
          id: String(index + 1),
          name: 'read_file',
          input: { relPath: 'src/index.ts', startLine: index * 10 + 1, endLine: index * 10 + 10 },
        },
      ],
    }));
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient(readResponses),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
      maxReadOnlySteps: 3,
      readOnlyReminderStep: 2,
      recheckAlreadyFixed,
    });

    const result = await loop.run();

    expect(recheckAlreadyFixed).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      alreadyFixed: true,
      reason: '当前代码已经满足 Reviewer 要求',
    });
  });

  it('只读上限后回灌回查结论并给最后行动机会，LLM 修改后修复成功', async () => {
    const loadedPrompts: string[] = [];
    const spyLoader = {
      load: (name: string, vars?: Record<string, string>) => {
        loadedPrompts.push(`${name} ${JSON.stringify(vars ?? {})}`);
        return defaultPromptLoader.load(name, vars);
      },
      register: () => undefined,
      setAssetDir: () => undefined,
    };
    const recheckAlreadyFixed = vi.fn().mockResolvedValue({
      alreadyFixed: false,
      reason: '问题仍存在：缺少 TODO 注释',
      evidence: '第 25 行未见 TODO 标记',
    });
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts', startLine: 1, endLine: 10 } }] },
        { toolCalls: [{ id: '2', name: 'read_file', input: { relPath: 'src/index.ts', startLine: 11, endLine: 20 } }] },
        { toolCalls: [{ id: '3', name: 'read_file', input: { relPath: 'src/index.ts', startLine: 21, endLine: 30 } }] },
        // 最后行动机会内实际修改
        { toolCalls: [{ id: '4', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } }] },
        { toolCalls: [{ id: '5', name: 'finish', input: { success: true, reason: 'done' } }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
      maxReadOnlySteps: 3,
      readOnlyReminderStep: 2,
      finalActingSteps: 3,
      recheckAlreadyFixed,
      promptLoader: spyLoader,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
    expect(recheckAlreadyFixed).toHaveBeenCalledTimes(1);
    // 谢幕消息必须携带回查结论（带诊断谢幕，而非机械暴毙）
    const finalRound = loadedPrompts.find(entry => entry.startsWith('fix-tool-loop-final-acting-round'));
    expect(finalRound).toBeDefined();
    expect(finalRound).toContain('缺少 TODO 注释');
    expect(finalRound).toContain('第 25 行未见 TODO');
  });

  it('最后行动机会内仍只读探索则失败，失败原因携带回查结论', async () => {
    const recheckAlreadyFixed = vi.fn().mockResolvedValue({
      alreadyFixed: false,
      reason: '问题仍存在：缺少 TODO 注释',
      evidence: '第 25 行未见 TODO 标记',
    });
    const readResponses = Array.from({ length: 6 }, (_, index) => ({
      toolCalls: [
        {
          id: String(index + 1),
          name: 'read_file',
          input: { relPath: 'src/index.ts', startLine: index * 10 + 1, endLine: index * 10 + 10 },
        },
      ],
    }));
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient(readResponses),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
      maxReadOnlySteps: 3,
      readOnlyReminderStep: 2,
      finalActingSteps: 3,
      recheckAlreadyFixed,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('缺少 TODO 注释');
    expect(result.reason).toContain('第 25 行未见 TODO');
    expect(result.reason).toContain('最后一轮带诊断的行动机会');
  });
  it('可配置 maxStepsWithoutProgress，缩短无进展早退阈值', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '4', name: 'validate', input: {} }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
      maxStepsWithoutProgress: 3,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('修复陷入循环');
  });

  it('可配置 staleReminderStep，在无进展初期就触发提醒', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        { toolCalls: [{ id: '2', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '4', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '5', name: 'validate', input: {} }] },
        { toolCalls: [{ id: '6', name: 'validate', input: {} }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
      maxStepsWithoutProgress: 5,
      staleReminderStep: 1,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('修复陷入循环');
  });

  it('content 包含工具调用 JSON 时兜底解析并执行', async () => {
    const loop = new FixToolLoop({
      llmClient: new LlmClient({
        apiKey: 'test',
        mock: {
          toolResponses: [
            {
              content: '{"name":"write_file","input":{"relPath":"src/index.ts","content":"fixed"}}',
              toolCalls: [],
            },
            { content: '{"name":"validate","input":{}}', toolCalls: [] },
            {
              content: '{"name":"finish","input":{"success":true,"reason":"done"}}',
              toolCalls: [],
            },
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

  it('finish 成功但未实际修改任何文件且重试禁用时返回失败', async () => {
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
      maxUnchangedFinishRetries: 0,
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
        {
          toolCalls: [
            { id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
          ],
        },
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
        {
          toolCalls: [
            { id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
          ],
        },
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
            {
              id: '1',
              name: 'write_file',
              input: { relPath: 'src/index.ts', content: 'line1\nline2\n' },
            },
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
      maxUnchangedFinishRetries: 0,
    });

    const result = await loop.run();

    expect(result.success).toBe(false);
    expect(result.reason).toContain('未实际修改或删除任何文件');
    expect(loop.getAppliedFiles()).not.toContain('src/index.ts');
  });

  it('finish 成功但未实际修改任何文件时触发重试，重试后实际修改可成功', async () => {
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'validate', input: {} }] },
        {
          toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }],
        },
        { toolCalls: [{ id: '3', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        {
          toolCalls: [
            { id: '4', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
          ],
        },
        { toolCalls: [{ id: '5', name: 'validate', input: {} }] },
        {
          toolCalls: [{ id: '6', name: 'finish', input: { success: true, reason: 'done' } }],
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

  it('apply_patch 成功后即使后续只读取/搜索同一文件也不应被误判为无进展并提前终止', async () => {
    const patchText = `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 line1
 line2
+line3`;
    const loop = new FixToolLoop({
      llmClient: createMockLlmClient([
        { toolCalls: [{ id: '1', name: 'apply_patch', input: { patchText } }] },
        { toolCalls: [{ id: '2', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
        {
          toolCalls: [
            {
              id: '3',
              name: 'search_in_file',
              input: { relPath: 'src/index.ts', keyword: 'line3' },
            },
          ],
        },
        { toolCalls: [{ id: '4', name: 'validate', input: {} }] },
        {
          toolCalls: [
            {
              id: '5',
              name: 'search_in_file',
              input: { relPath: 'src/index.ts', keyword: 'line2' },
            },
          ],
        },
        { toolCalls: [{ id: '6', name: 'finish', input: { success: true, reason: 'done' } }] },
      ]),
      worktreeManager: createMockWorktreeManager(),
      finding: mockFinding,
      mr: mockMR,
      maxSteps: 20,
    });

    const result = await loop.run();

    expect(result.success).toBe(true);
    expect(loop.getAppliedFiles()).toContain('src/index.ts');
  });
});
