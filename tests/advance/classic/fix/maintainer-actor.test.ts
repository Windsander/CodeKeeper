import { describe, it, expect, vi } from 'vitest';
import {
  MaintainerActor,
  stripAnsiCodes,
  extractCommitRejectionSection,
} from '../../../../src/advance/classic/fix/maintainer-actor.js';
import { LlmClient } from '../../../../src/advance/llm/client.js';
import type {
  MergeRequest,
  ReviewFinding,
  Discussion,
} from '../../../../src/advance/classic/provider/types.js';
import type {
  MaintainerBrain,
  CognitiveDecision,
} from '../../../../src/advance/classic/fix/maintainer-brain.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';
import type { MrAgentState } from '../../../../src/advance/classic/runners/shared/state-utils.js';
import type { IMemoryClient } from '../../../../src/advance/classic/memory/types.js';

function createMockBrain(overrides: Partial<MaintainerBrain> = {}) {
  return {
    decideEnvironmentPrep: vi.fn().mockResolvedValue({ reason: '无需环境准备' }),
    ...overrides,
  } as unknown as MaintainerBrain;
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

const mockDiscussion: Discussion = {
  id: 'd-1',
  resolvable: true,
  resolved: false,
  notes: [],
};

const mockFinding: ReviewFinding = {
  severity: 'MEDIUM',
  file: 'src/index.ts',
  line: 2,
  message: '变量未使用',
  suggestion: '删除',
  autoFixable: true,
};

function createMockProvider() {
  return {
    addDiscussionNote: vi.fn().mockResolvedValue(undefined),
    resolveDiscussion: vi.fn().mockResolvedValue(undefined),
  } as unknown as import('../../../../src/advance/classic/provider/gitlab-provider.js').GitLabProvider;
}

function createMockWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    getWorktreePath: vi.fn().mockReturnValue('/tmp/maintainer-test-worktree'),
    ensureWorktree: vi.fn().mockResolvedValue(undefined),
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
    prepareEnvironment: vi.fn().mockResolvedValue(undefined),
    resolveFilePath: vi.fn().mockImplementation(async (p: string) => p),
    readFile: vi.fn().mockReturnValue('const unused = 1;\n'),
    writeFile: vi.fn().mockReturnValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    removeFile: vi.fn().mockResolvedValue(undefined),
    applyPatch: vi.fn().mockResolvedValue(false),
    runScript: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as WorktreeManager;
}

function createMockLlmClient(
  toolResponses: Array<{
    content?: string;
    toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
    stopReason?: string;
  }>
): LlmClient {
  return new LlmClient({
    apiKey: 'test',
    mock: { toolResponses },
  });
}

function createState(): MrAgentState {
  return {
    interactiveThreads: {},
    processedDiscussions: {},
  } as MrAgentState;
}

describe('MaintainerActor', () => {
  it('fix 成功后提交、resolve 并评论包含 reasoning', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain();

    const llmClient = createMockLlmClient([
      {
        toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }],
      },
      {
        toolCalls: [
          { id: '2', name: 'write_file', input: { relPath: 'src/index.ts', content: '' } },
        ],
      },
      {
        toolCalls: [{ id: '3', name: 'validate', input: {} }],
      },
      {
        toolCalls: [
          {
            id: '4',
            name: 'finish',
            input: { success: true, reason: '已删除未使用变量并校验通过' },
          },
        ],
      },
    ]);

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '可以修复',
      fixDescription: '删除未使用变量',
      analysis: '变量未使用',
      consideredOptions: ['删除', '保留'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    await actor.applyDecision(mockMR, mockDiscussion, mockFinding, decision, createState());

    expect(worktreeManager.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringContaining('变量未使用'),
      { setUpstream: false }
    );
    expect(provider.resolveDiscussion).toHaveBeenCalledWith(mockMR.iid, mockDiscussion.id);
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('最终决策')
    );
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('删除更干净')
    );
  });

  it('修复循环同时收到原始 finding 和 Brain 补充方向', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain();
    const llmClient = createMockLlmClient([]);
    const captured: { task?: string; system?: string } = {};
    vi.spyOn(llmClient, 'completeWithTools').mockImplementation(
      async (messages, _tools, options) => {
        captured.task = String(messages[0]?.content ?? '');
        captured.system = options?.system;
        return {
          content: '',
          toolCalls: [
            {
              id: '1',
              name: 'finish',
              input: { success: false, reason: '需要继续分析所有生命周期引用' },
            },
          ],
          stopReason: 'tool_use',
        };
      }
    );
    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '需要修复',
      fixDescription: '检查 singleton reset 与 dispose 的多实例影响',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'medium',
    };

    const result = await actor.executeFix(mockMR, mockDiscussion, mockFinding, decision, createState());

    expect(result.codeApplied).toBe(false);
    expect(captured.task).toContain('变量未使用');
    expect(captured.task).toContain('删除');
    expect(captured.system).toContain('检查 singleton reset 与 dispose 的多实例影响');
  });
  it('commit 被 hook 拒绝时学习提交规范、写入项目记忆并重试', async () => {
    const provider = createMockProvider();
    const commitAndPush = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Worktree commit 失败: ❌ Commit message 不符合 Conventional Commits 规范。格式: <type>(<scope>): <description>'
        )
      )
      .mockResolvedValueOnce(undefined);
    const worktreeManager = createMockWorktreeManager({ commitAndPush });
    const brain = createMockBrain();

    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
          {
            toolCalls: [
              {
                id: '2',
                name: 'write_file',
                input: { relPath: 'src/index.ts', content: 'const used = 1;' },
              },
            ],
          },
          { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
          { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'done' } }] },
        ],
        responses: [
          '{"convention": "Conventional Commits 格式：<type>(<scope>): <description>"}',
          '{"message": "fix: 删除未使用变量"}',
        ],
      },
    });

    const memoryClient = {
      context: { appId: 'a', projectId: 'p1', agentId: 'm', userId: 'u', sessionId: 's' },
      recallProjectKnowledge: vi.fn().mockResolvedValue([]),
      recordProjectKnowledge: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMemoryClient;

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
      memoryClient,
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '可以修复',
      fixDescription: '删除未使用变量',
      confidence: 'high',
    };

    const ok = await actor.applyDecision(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(ok.codeApplied).toBe(true);
    expect(commitAndPush).toHaveBeenCalledTimes(2);
    // 第一次用朴素默认信息，第二次用按规范生成的信息
    expect(commitAndPush.mock.calls[0][1]).toContain('变量未使用');
    expect(commitAndPush.mock.calls[1][1]).toBe('fix: 删除未使用变量');
    // 规范被写入项目级记忆
    expect(memoryClient.recordProjectKnowledge).toHaveBeenCalledWith([
      expect.objectContaining({
        category: 'convention',
        confidence: 'high',
        content: expect.stringContaining('Conventional Commits'),
      }),
    ]);
  });

  it('commit 被拒绝且与格式无关时不重试', async () => {
    const provider = createMockProvider();
    const commitAndPush = vi
      .fn()
      .mockRejectedValue(new Error('Worktree commit 失败: pre-commit lint 未通过'));
    const worktreeManager = createMockWorktreeManager({ commitAndPush });
    const brain = createMockBrain();

    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
          {
            toolCalls: [
              {
                id: '2',
                name: 'write_file',
                input: { relPath: 'src/index.ts', content: 'const used = 1;' },
              },
            ],
          },
          { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
          { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'done' } }] },
        ],
        // LLM 判断不是格式问题
        responses: ['{"convention": ""}'],
      },
    });

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '可以修复',
      fixDescription: '删除未使用变量',
      confidence: 'high',
    };

    const ok = await actor.applyDecision(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(ok.codeApplied).toBe(false);
    expect(commitAndPush).toHaveBeenCalledTimes(1);
  });

  it('hook 输出被无关内容和 ANSI 转义码淹没时仍能学习规范并重试', async () => {
    const provider = createMockProvider();
    const noise = Array.from({ length: 50 }, (_, i) => `第 ${i} 行无关输出...`).join('\n');
    const ansiNoise = '[33m[1m警告[22m[39m';
    const commitError = `Worktree commit 失败: ${noise}\n${ansiNoise}\n❌ Commit message 不符合 Conventional Commits 规范。\n格式: <type>(<scope>): <description>\ntypes: feat | fix | docs`;
    const commitAndPush = vi
      .fn()
      .mockRejectedValueOnce(new Error(commitError))
      .mockResolvedValueOnce(undefined);
    const worktreeManager = createMockWorktreeManager({ commitAndPush });
    const brain = createMockBrain();

    const llmClient = new LlmClient({
      apiKey: 'test',
      mock: {
        toolResponses: [
          { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
          {
            toolCalls: [
              {
                id: '2',
                name: 'write_file',
                input: { relPath: 'src/index.ts', content: 'const used = 1;' },
              },
            ],
          },
          { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
          { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'done' } }] },
        ],
        responses: [
          '{"convention": "Conventional Commits 格式：<type>(<scope>): <description>"}',
          // LLM 生成不带 type 前缀的描述，应由兜底逻辑补为 fix:
          '{"message": "删除未使用变量"}',
        ],
      },
    });

    const memoryClient = {
      context: { appId: 'a', projectId: 'p1', agentId: 'm', userId: 'u', sessionId: 's' },
      recallProjectKnowledge: vi.fn().mockResolvedValue([]),
      recordProjectKnowledge: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMemoryClient;

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
      memoryClient,
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '可以修复',
      fixDescription: '删除未使用变量',
      confidence: 'high',
    };

    const ok = await actor.applyDecision(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(ok.codeApplied).toBe(true);
    expect(commitAndPush).toHaveBeenCalledTimes(2);
    expect(commitAndPush.mock.calls[1][1]).toBe('fix: 删除未使用变量');
    expect(memoryClient.recordProjectKnowledge).toHaveBeenCalled();
  });

  it('fix 且 deleteFile=true 时删除文件、提交并 resolve discussion', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain();

    const actor = new MaintainerActor({
      provider,
      llmClient: createMockLlmClient([]),
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: 'Reviewer 指出该设计文档不应上传',
      fixDescription: '删除不应上传的设计文档',
      analysis: 'docs/ 下的设计文档不应进入 git',
      consideredOptions: ['删除文件', '保留文件'],
      reasoning: '按项目规范，docs/ 设计文档不提交，应删除',
      confidence: 'high',
      deleteFile: true,
    };

    const finding: ReviewFinding = {
      ...mockFinding,
      file: 'docs/design/telemetry-plan.md',
      line: 1,
    };

    const ok = await actor.applyDecision(mockMR, mockDiscussion, finding, decision, createState());

    expect(ok.codeApplied).toBe(true);
    expect(worktreeManager.removeFile).toHaveBeenCalledWith(finding.file);
    expect(worktreeManager.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringContaining('移除不应上传的文件'),
      { setUpstream: false }
    );
    expect(provider.resolveDiscussion).toHaveBeenCalledWith(mockMR.iid, mockDiscussion.id);
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('删除文件')
    );
  });

  it('fix 工具循环失败时转为 ask，不提交', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain();

    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          {
            id: '1',
            name: 'finish',
            input: { success: false, reason: '无法安全删除该变量' },
          },
        ],
      },
    ]);

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '尝试修复',
      fixDescription: '删除变量',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'medium',
    };

    await actor.applyDecision(mockMR, mockDiscussion, mockFinding, decision, createState());

    expect(worktreeManager.commitAndPush).not.toHaveBeenCalled();
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('未成功')
    );
  });

  it('finish 成功但未 validate 时不提交并转 ask', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain();

    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          {
            id: '1',
            name: 'finish',
            input: { success: true, reason: '我觉得可以了' },
          },
        ],
      },
    ]);

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
    });

    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '尝试修复',
      fixDescription: '删除变量',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'medium',
    };

    await actor.applyDecision(mockMR, mockDiscussion, mockFinding, decision, createState());

    expect(worktreeManager.commitAndPush).not.toHaveBeenCalled();
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('未成功')
    );
  });

  it('批量修复无进展后回查为 already-fixed 时不提交且不返回失败', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const recheckAlreadyFixed = vi.fn().mockResolvedValue({
      alreadyFixed: true,
      reason: '当前完整文件已经满足要求',
      evidence: '默认 sink 路径已有测试覆盖',
    });
    const brain = createMockBrain({ recheckAlreadyFixed });
    const llmClient = createMockLlmClient([
      { toolCalls: [{ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } }] },
      { toolCalls: [{ id: '2', name: 'validate', input: {} }] },
      { toolCalls: [{ id: '3', name: 'validate', input: {} }] },
      { toolCalls: [{ id: '4', name: 'validate', input: {} }] },
      { toolCalls: [{ id: '5', name: 'validate', input: {} }] },
      { toolCalls: [{ id: '6', name: 'validate', input: {} }] },
    ]);
    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
    });

    const result = await actor.executeBatchFix(
      mockMR,
      [{ finding: mockFinding, fileContent: 'const current = true;' }],
      '旧评审指出默认路径缺少覆盖'
    );

    expect(recheckAlreadyFixed).toHaveBeenCalledWith(mockFinding);
    expect(result).toEqual({
      success: true,
      reason: '所有 finding 在当前代码中均已修复，无需提交',
      appliedFiles: [],
      deletedFiles: [],
      alreadyFixedItems: [
        {
          file: 'src/index.ts',
          line: 2,
          reason: '默认 sink 路径已有测试覆盖',
        },
      ],
    });
    expect(worktreeManager.commitAndPush).not.toHaveBeenCalled();
  });

  it('汇总全部为无需修复项时逐项回复并 resolve discussion', async () => {
    const provider = createMockProvider();
    const actor = new MaintainerActor({
      provider,
      llmClient: createMockLlmClient([]),
      worktreeManager: createMockWorktreeManager(),
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });

    await actor.postSummary(
      mockMR,
      mockDiscussion,
      [],
      [],
      [],
      [{ fileLine: 'src/facade.ts:20', reason: '实例生命周期互不影响，无需修改' }],
      [{ fileLine: 'src/app.ts:10', reason: '后续提交已经覆盖该问题' }],
      createState()
    );

    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('src/app.ts:10: 后续提交已经覆盖该问题')
    );
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('src/facade.ts:20: 实例生命周期互不影响，无需修改')
    );
    expect(provider.resolveDiscussion).toHaveBeenCalledWith(mockMR.iid, mockDiscussion.id);
  });
});

describe('提交信息输出预处理', () => {
  it('stripAnsiCodes 移除 ANSI 转义码', () => {
    expect(stripAnsiCodes('[33m[1m警告[22m[39m')).toBe('警告');
    expect(stripAnsiCodes('无转义字符')).toBe('无转义字符');
  });

  it('extractCommitRejectionSection 从冗长输出中提取 commit 规范片段', () => {
    const noise = 'lint 警告...\n'.repeat(30);
    const section =
      '❌ Commit message 不符合 Conventional Commits 规范。\n格式: <type>(<scope>): <description>';
    const extracted = extractCommitRejectionSection(`${noise}${section}`);
    expect(extracted).toContain('Commit message');
    expect(extracted).toContain('Conventional Commits');
    expect(extracted.length).toBeLessThan(noise.length + section.length);
  });

  it('extractCommitRejectionSection 无相关标记时返回原始前缀', () => {
    const text = '完全无关的日志内容'.repeat(10);
    expect(extractCommitRejectionSection(text)).toContain('完全无关的日志内容');
  });
});
