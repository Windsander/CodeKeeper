import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import type { MrLifecycleMetrics } from '../../../../src/advance/classic/runners/shared/mr-lifecycle.js';

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

/**
 * 每个用例使用独立的 discussion 夹具。
 * deliverDiscussionReply 会就地写入 resolved/notes，模块级共享对象会跨用例污染，
 * 导致后续用例因 discussion.resolved 已为 true 而断言不到 resolveDiscussion 调用。
 */
let mockDiscussion: Discussion;

beforeEach(() => {
  mockDiscussion = {
    id: 'd-1',
    resolvable: true,
    resolved: false,
    notes: [],
  };
});

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

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(false);
    expect(captured.task).toContain('变量未使用');
    expect(captured.task).toContain('删除');
    expect(captured.system).toContain('检查 singleton reset 与 dispose 的多实例影响');
  });

  it('Runner 接管重试时单次失败不立即向 Reviewer 求助', async () => {
    const provider = createMockProvider();
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '需要修复',
      fixDescription: '调整当前实现',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'medium',
    };
    const actor = new MaintainerActor({
      provider,
      llmClient: createMockLlmClient([
        {
          toolCalls: [
            { id: '1', name: 'finish', input: { success: false, reason: '本轮尚未完成' } },
          ],
        },
      ]),
      worktreeManager: createMockWorktreeManager(),
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });

    const result = await actor.applyDecision(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState(),
      { askOnFixFailure: false }
    );

    expect(result.codeApplied).toBe(false);
    expect(provider.addDiscussionNote).not.toHaveBeenCalled();
    expect(decision.question).toBeUndefined();
  });

  it('局部 finding 越界修改其他文件时拒绝提交', async () => {
    const worktreeManager = createMockWorktreeManager();
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient: createMockLlmClient([
        {
          toolCalls: [
            { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
          ],
        },
        {
          toolCalls: [
            {
              id: '2',
              name: 'write_file',
              input: { relPath: 'virtual/module-b.ts', content: 'unexpected' },
            },
          ],
        },
        { toolCalls: [{ id: '3', name: 'finish', input: { success: true, reason: 'done' } }] },
      ]),
      worktreeManager,
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '局部修复',
      fixDescription: '只调整目标文件',
      scope: 'local',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(false);
    expect(result.error).toContain('越界修改');
    expect(worktreeManager.commitAndPush).not.toHaveBeenCalled();
  });

  it('批量局部 finding 越界修改未批准文件时拒绝整批提交', async () => {
    const changedFiles = new Set<string>();
    const worktreeManager = createMockWorktreeManager({
      writeFile: vi.fn().mockImplementation((filePath: string) => {
        changedFiles.add(filePath);
      }),
      listChangedFiles: vi
        .fn()
        .mockImplementation(async () =>
          Array.from(changedFiles, filePath => ({ path: filePath, deleted: false }))
        ),
    });
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient: createMockLlmClient([
        {
          toolCalls: [
            { id: '1', name: 'write_file', input: { relPath: 'src/a.ts', content: 'fixed a' } },
          ],
        },
        { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'a done' } }] },
        {
          toolCalls: [
            { id: '3', name: 'write_file', input: { relPath: 'src/b.ts', content: 'fixed b' } },
          ],
        },
        {
          toolCalls: [
            {
              id: '4',
              name: 'write_file',
              input: { relPath: 'virtual/module-c.ts', content: 'unexpected' },
            },
          ],
        },
        { toolCalls: [{ id: '5', name: 'finish', input: { success: true, reason: 'b done' } }] },
      ]),
      worktreeManager,
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });
    const findings: ReviewFinding[] = [
      {
        severity: 'LOW',
        file: 'src/a.ts',
        line: 10,
        message: '修正 a 的局部逻辑',
        suggestion: '只修改 a',
      },
      {
        severity: 'MEDIUM',
        file: 'src/b.ts',
        line: 20,
        message: '修正 b 的局部逻辑',
        suggestion: '只修改 b',
      },
    ];

    const result = await actor.executeBatchFix(
      mockMR,
      findings.map(finding => ({ finding, fileContent: 'current', scope: 'local' })),
      '批量修复两个局部问题'
    );

    expect(result.success).toBe(false);
    expect(result.reason).toContain('virtual/module-c.ts');
    expect(result.itemResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'src/a.ts', status: 'deferred' }),
        expect.objectContaining({ file: 'src/b.ts', status: 'failed' }),
      ])
    );
    expect(worktreeManager.commitAndPush).not.toHaveBeenCalled();
  });

  it('坏基线编译不会阻止进入修复循环', async () => {
    const captured: { system?: string } = {};
    const llmClient = createMockLlmClient([]);
    const responses = [
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ];
    vi.spyOn(llmClient, 'completeWithTools').mockImplementation(
      async (_messages, _tools, options) => {
        captured.system = options?.system;
        return { content: '', ...responses.shift()!, stopReason: 'tool_use' };
      }
    );
    const prepareEnvironment = vi.fn().mockResolvedValue({
      compilePackagesFailure: 'src/module.ts(8,2): error TS2305: missing export',
    });
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager: createMockWorktreeManager({ prepareEnvironment }),
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '需要修复',
      fixDescription: '调整目标文件',
      scope: 'local',
      analysis: '',
      consideredOptions: [],
      reasoning: '',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(true);
    expect(prepareEnvironment).toHaveBeenCalledWith({ allowCompileFailure: true });
    expect(captured.system).toContain('修复前基线');
    expect(captured.system).toContain('error TS2305');
  });

  it('CI 修复使用解析后的仓库路径并可穿过坏基线', async () => {
    const captured: { task?: string } = {};
    const llmClient = createMockLlmClient([]);
    const responses = [
      {
        toolCalls: [
          {
            id: '1',
            name: 'write_file',
            input: { relPath: 'packages/example/src/module.ts', content: 'fixed' },
          },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ];
    vi.spyOn(llmClient, 'completeWithTools').mockImplementation(async (messages, _tools) => {
      captured.task = String(messages[0]?.content ?? '');
      return { content: '', ...responses.shift()!, stopReason: 'tool_use' };
    });
    const prepareEnvironment = vi.fn().mockResolvedValue({
      compilePackagesFailure: 'src/module.ts(12,15): error TS2305: Module has no exported member.',
    });
    const worktreeManager = createMockWorktreeManager({
      prepareEnvironment,
      resolveFilePath: vi.fn().mockResolvedValue('packages/example/src/module.ts'),
    });
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });

    const result = await actor.executeCiFix(mockMR, {
      status: 'failed',
      pipelineId: 10,
      failedJobs: [
        {
          id: 20,
          name: 'build',
          stage: 'verify',
          failureReason: 'script_failure',
          traceTail: 'src/module.ts(12,15): error TS2305: Module has no exported member.',
        },
      ],
    });

    expect(result.codeApplied).toBe(true);
    expect(result.appliedFiles).toContain('packages/example/src/module.ts');
    expect(captured.task).toContain('packages/example/src/module.ts');
    expect(prepareEnvironment).toHaveBeenCalledWith({ allowCompileFailure: true });
  });

  it('批量修复只把当前 finding 注入工具循环，不混入同 discussion 的其他证据', async () => {
    const llmClient = createMockLlmClient([]);
    const captured: { task?: string; system?: string } = {};
    vi.spyOn(llmClient, 'completeWithTools').mockImplementation(
      async (messages, _tools, options) => {
        captured.task = String(messages[0]?.content ?? '');
        captured.system = options?.system;
        return {
          content: '',
          toolCalls: [
            { id: '1', name: 'finish', input: { success: false, reason: '当前项无法自动修复' } },
          ],
          stopReason: 'tool_use',
        };
      }
    );
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager: createMockWorktreeManager(),
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });
    const finding: ReviewFinding = {
      severity: 'MEDIUM',
      file: 'src/a.ts',
      line: 10,
      message: '当前函数缺少边界保护',
      suggestion: '补充空值判断',
    };

    await actor.executeBatchFix(
      mockMR,
      [{ finding, fileContent: 'export function current() {}' }],
      'src/b.ts:20 的 `otherFunction` 已经修复，src/c.ts:30 仍需检查'
    );

    expect(captured.task).toContain('src/a.ts');
    expect(captured.task).not.toContain('src/b.ts');
    expect(captured.task).not.toContain('otherFunction');
    expect(captured.system).not.toContain('src/b.ts');
    expect(captured.system).not.toContain('otherFunction');
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
          '{"retry": true, "convention": "Conventional Commits 格式：<type>(<scope>): <description>", "message": "fix: 删除未使用变量"}',
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
        responses: ['{"retry": false, "convention": "", "message": ""}'],
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

  it('长 hook 输出尾部给出自定义规则时按该规则生成提交信息', async () => {
    const provider = createMockProvider();
    const noise = Array.from({ length: 324 }, (_, i) => `第 ${i} 行 lint/test 输出...`).join('\n');
    const ansiNoise = '[33m[1m警告[22m[39m';
    const commitError = `Worktree commit 失败: ${noise}\n${ansiNoise}\n❌ 提交标题不符合项目模板。\n要求: [任务编号] 简短说明\n示例: [MEM-42] 修正遥测重置\n当前: 批量修复 1 个 Reviewer 问题`;
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
          '{"retry": true, "convention": "提交标题必须使用 [任务编号] 简短说明 格式。", "message": "[MEM-42] 删除未使用变量"}',
        ],
      },
    });

    const memoryClient = {
      context: { appId: 'a', projectId: 'p1', agentId: 'm', userId: 'u', sessionId: 's' },
      recallProjectKnowledge: vi.fn().mockResolvedValue([]),
      recordProjectKnowledge: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMemoryClient;

    const completeJson = vi.spyOn(llmClient, 'completeJson');

    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'CodeKeeper Maintainer',
      memoryClient,
    });

    const result = await actor.executeBatchFix(
      mockMR,
      [{ finding: mockFinding, fileContent: 'const unused = 1;' }],
      'Reviewer 要求删除未使用变量'
    );

    expect(result.success).toBe(true);
    expect(commitAndPush).toHaveBeenCalledTimes(2);
    expect(commitAndPush.mock.calls[0][1]).toContain('批量修复 1 个 Reviewer 问题');
    expect(commitAndPush.mock.calls[1][1]).toBe('[MEM-42] 删除未使用变量');
    const recoveryPrompt = String(completeJson.mock.calls.at(-1)?.[0] ?? '');
    expect(recoveryPrompt).not.toContain('第 0 行 lint/test 输出');
    expect(recoveryPrompt).toContain('当前: 批量修复 1 个 Reviewer 问题');
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
    // F2：无项目记忆/静态探测命中时，默认提交信息也必须具备合规形态
    expect(worktreeManager.commitAndPush).toHaveBeenCalledWith(
      'feature/test',
      expect.stringMatching(/^chore\(review\): 移除不应上传的文件/),
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
      itemResults: [
        {
          file: 'src/index.ts',
          line: 2,
          status: 'already-fixed',
          reason: '默认 sink 路径已有测试覆盖',
        },
      ],
    });
    expect(worktreeManager.commitAndPush).not.toHaveBeenCalled();
  });

  it('后续 finding 失败时保留 already-fixed，并把未执行项标记为 deferred', async () => {
    const firstFinding: ReviewFinding = {
      severity: 'LOW',
      file: 'src/a.ts',
      line: 10,
      message: '确认现有保护是否完整',
      suggestion: '检查当前实现',
    };
    const secondFinding: ReviewFinding = {
      severity: 'MEDIUM',
      file: 'src/b.ts',
      line: 20,
      message: '补充边界判断',
      suggestion: '修正逻辑',
    };
    const thirdFinding: ReviewFinding = {
      severity: 'LOW',
      file: 'src/c.ts',
      line: 30,
      message: '清理冗余分支',
      suggestion: '删除多余代码',
    };
    const recheckAlreadyFixed = vi.fn().mockResolvedValue({
      alreadyFixed: true,
      reason: '当前代码已经满足要求',
      evidence: '目标函数已经包含所需保护',
    });
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient: createMockLlmClient([
        {
          toolCalls: [
            {
              id: '1',
              name: 'finish',
              input: {
                success: false,
                alreadyFixed: true,
                reason: '当前代码已经修复',
                evidence: '目标函数已经包含所需保护',
              },
            },
          ],
        },
        {
          toolCalls: [
            { id: '2', name: 'finish', input: { success: false, reason: '无法安全修改当前项' } },
          ],
        },
      ]),
      worktreeManager: createMockWorktreeManager(),
      brain: createMockBrain({ recheckAlreadyFixed }),
      maintainerName: 'Maintainer',
    });

    const result = await actor.executeBatchFix(
      mockMR,
      [
        { finding: firstFinding, fileContent: 'export function first() {}' },
        { finding: secondFinding, fileContent: 'export function second() {}' },
        { finding: thirdFinding, fileContent: 'export function third() {}' },
      ],
      '三个独立 finding'
    );

    expect(result.success).toBe(false);
    expect(result.alreadyFixedItems).toEqual([
      { file: 'src/a.ts', line: 10, reason: '目标函数已经包含所需保护' },
    ]);
    expect(result.itemResults).toEqual([
      {
        file: 'src/a.ts',
        line: 10,
        status: 'already-fixed',
        reason: '目标函数已经包含所需保护',
      },
      {
        file: 'src/b.ts',
        line: 20,
        status: 'failed',
        reason: '无法安全修改当前项',
      },
      {
        file: 'src/c.ts',
        line: 30,
        status: 'deferred',
        reason: '前序 finding 未完成，本轮尚未执行',
      },
    ]);
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

  it('等待 Reviewer 时发布新进度不会刷新首次提问时间', async () => {
    const provider = createMockProvider();
    const actor = new MaintainerActor({
      provider,
      llmClient: createMockLlmClient([]),
      worktreeManager: createMockWorktreeManager(),
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });
    const state = createState();
    const askedAt = Date.now() - 60_000;
    state.interactiveThreads[mockDiscussion.id] = {
      status: 'awaiting-reply',
      askedAt,
      question: '请确认预期行为',
      filePath: 'src/a.ts',
    };

    await actor.postSummary(
      mockMR,
      mockDiscussion,
      [],
      ['src/b.ts:20 — 本轮修复失败'],
      [],
      [],
      [],
      state
    );

    expect(state.interactiveThreads[mockDiscussion.id]?.askedAt).toBe(askedAt);
    expect(state.maintainerThreadState?.[mockDiscussion.id]?.delivery?.awaitingReplyAt).toBe(
      askedAt
    );
    expect(provider.addDiscussionNote).toHaveBeenCalledWith(
      mockMR.iid,
      mockDiscussion.id,
      expect.stringContaining('请确认预期行为')
    );
  });
});

describe('提交信息输出预处理', () => {
  it('stripAnsiCodes 移除 ANSI 转义码', () => {
    expect(stripAnsiCodes('[33m[1m警告[22m[39m')).toBe('警告');
    expect(stripAnsiCodes('无转义字符')).toBe('无转义字符');
  });

  it('extractCommitRejectionSection 只保留冗长输出尾部诊断窗口', () => {
    const noise = Array.from({ length: 150 }, (_, index) => `lint 警告 ${index}`).join('\n');
    const section =
      '❌ Commit message 不符合 Conventional Commits 规范。\n格式: <type>(<scope>): <description>';
    const extracted = extractCommitRejectionSection(`${noise}\n${section}`);
    expect(extracted).toContain('Commit message');
    expect(extracted).toContain('Conventional Commits');
    expect(extracted).not.toContain('lint 警告 0');
    expect(extracted).toContain('lint 警告 149');
  });

  it('extractCommitRejectionSection 无相关标记时仍返回尾部诊断', () => {
    const text = Array.from({ length: 150 }, (_, index) => `完全无关的日志内容 ${index}`).join(
      '\n'
    );
    const extracted = extractCommitRejectionSection(text);
    expect(extracted).not.toContain('完全无关的日志内容 0\n');
    expect(extracted).toContain('完全无关的日志内容 149');
  });
});

describe('提交管道（F3/L3）', () => {
  it('lint 类 hook 失败回流修复循环，消除错误后重试提交成功', async () => {
    const lintFailure =
      'Worktree commit 失败:\nsrc/index.ts\n  2:7  error  no-unused-vars\n✖ 3 problems (3 errors, 0 warnings)';
    const commitAndPush = vi
      .fn()
      .mockRejectedValueOnce(new Error(lintFailure))
      .mockResolvedValue(undefined);
    const worktreeManager = createMockWorktreeManager({ commitAndPush });
    const brain = createMockBrain({
      recheckAlreadyFixed: vi
        .fn()
        .mockResolvedValue({ alreadyFixed: false, reason: '校验错误仍存在' }),
    });
    const llmClient = createMockLlmClient([
      // 第一轮修复：改文件 + finish
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
      // 回流轮：根据蒸馏诊断再改 + finish
      {
        toolCalls: [
          {
            id: '3',
            name: 'write_file',
            input: { relPath: 'src/index.ts', content: 'lint-fixed' },
          },
        ],
      },
      { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'lint done' } }] },
    ]);
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
    });

    const result = await actor.executeBatchFix(
      mockMR,
      [{ finding: mockFinding, fileContent: 'const unused = 1;' }],
      'Reviewer 要求删除未使用变量'
    );

    expect(result.success).toBe(true);
    expect(commitAndPush).toHaveBeenCalledTimes(2);
  });

  it('permission 类失败不回流不重试，错误为 ≤10 行蒸馏诊断而非原文', async () => {
    const noise = Array.from({ length: 200 }, (_, i) => `第 ${i} 行 hook 日志输出`).join('\n');
    const commitAndPush = vi
      .fn()
      .mockRejectedValue(new Error(`${noise}\nremote: Permission to repo denied (403).`));
    const worktreeManager = createMockWorktreeManager({ commitAndPush });
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '删除未使用变量',
      fixDescription: '删除未使用变量',
      analysis: '存在未使用变量',
      consideredOptions: ['删除'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(false);
    expect(commitAndPush).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('【提交失败分类: permission】');
    expect(result.error).not.toContain('第 0 行 hook 日志输出');
    expect(result.error?.split('\n').length).toBeLessThanOrEqual(10);
  });

  it('提交信息重写后的第二次失败仍只返回蒸馏诊断', async () => {
    const firstNoise = Array.from({ length: 120 }, (_, index) => `lint warning ${index}`).join(
      '\n'
    );
    const secondNoise = Array.from({ length: 200 }, (_, index) => `push detail ${index}`).join(
      '\n'
    );
    const commitAndPush = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          `${firstNoise}\n\u001b[31mCommit message 不符合项目格式\u001b[0m\n要求: [任务编号] 简短说明`
        )
      )
      .mockRejectedValueOnce(
        new Error(
          `${secondNoise}\n\u001b[33mremote: Permission to repository denied (403).\u001b[0m`
        )
      );
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    vi.spyOn(llmClient, 'completeJson').mockResolvedValue(
      JSON.stringify({
        retry: true,
        convention: '提交标题使用 [任务编号] 简短说明',
        message: '[TASK-1] 修正边界处理',
      })
    );
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager: createMockWorktreeManager({ commitAndPush }),
      brain: createMockBrain(),
      maintainerName: 'Maintainer',
    });

    const result = await actor.executeBatchFix(
      mockMR,
      [{ finding: mockFinding, fileContent: 'const unused = 1;' }],
      '修正边界处理'
    );

    expect(commitAndPush).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('【提交失败分类: permission】');
    expect(result.reason).not.toContain('\u001b[');
    expect(result.reason).not.toContain('push detail 0');
    expect(result.reason.length).toBeLessThanOrEqual(6_000);
    expect(result.reason.split('\n').length).toBeLessThanOrEqual(10);
    expect(result.itemResults[0]).toMatchObject({ status: 'failed' });
  });
});

describe('ask 门禁（L2）与修复终局插桩（M7）', () => {
  it('仓库内可自查的索问被门禁拦截，转为修复自查且不发布原索问', async () => {
    const provider = createMockProvider();
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    const actor = new MaintainerActor({
      provider,
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
    });
    const decision: CognitiveDecision = {
      action: 'ask',
      reason: '需要文件内容才能分析',
      question: '请提供 src/index.ts 文件的内容，以便分析当前实现。',
      analysis: '缺少文件内容',
      consideredOptions: ['索要文件'],
      reasoning: '没有文件无法分析',
      confidence: 'low',
    };

    const result = await actor.applyDecision(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    // 门禁后转为修复：走了 commit，且从未把原索问发布到 MR
    expect(result.codeApplied).toBe(true);
    expect(worktreeManager.commitAndPush).toHaveBeenCalled();
    const postedBodies = provider.addDiscussionNote.mock.calls.map(call => String(call[2]));
    expect(postedBodies.some(body => body.includes('请提供 src/index.ts 文件的内容'))).toBe(false);
  });

  it('修复循环失败时写入 EverOS 终局记录（outcome:failure）', async () => {
    const memoryClient = {
      context: { projectId: 'p1' },
      recordFixAttempt: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMemoryClient;
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [{ id: '1', name: 'finish', input: { success: false, reason: '无法定位根因' } }],
      },
    ]);
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
      memoryClient,
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '修复未使用变量',
      fixDescription: '删除未使用变量',
      analysis: '存在未使用变量',
      consideredOptions: ['删除'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(false);
    expect(memoryClient.recordFixAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        mrIid: mockMR.iid,
        file: mockFinding.file,
        success: false,
        reason: expect.stringContaining('outcome:failure'),
      })
    );
  });

  it('修复成功时写入 EverOS 终局记录（outcome:success）', async () => {
    const memoryClient = {
      context: { projectId: 'p1' },
      recordFixAttempt: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMemoryClient;
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
      memoryClient,
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '修复未使用变量',
      fixDescription: '删除未使用变量',
      analysis: '存在未使用变量',
      consideredOptions: ['删除'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(true);
    expect(memoryClient.recordFixAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        reason: expect.stringContaining('outcome:success'),
      })
    );
  });
});

describe('M 系列过程指标（G8）', () => {
  function createMetrics(): MrLifecycleMetrics {
    return {
      discussionsTotal: 0,
      discussionsResolved: 0,
      findingsFixed: 0,
      findingsRejected: 0,
      findingsSuspended: 0,
      fixPushes: 0,
      humanFollowupsAfterFix: 0,
    };
  }

  it('commit 首次尝试成功计入 commitFirstTryPasses', async () => {
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    const metrics = createMetrics();
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
      metrics,
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '删除未使用变量',
      fixDescription: '删除未使用变量',
      analysis: '存在未使用变量',
      consideredOptions: ['删除'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(true);
    expect(metrics.commitFirstTryPasses).toBe(1);
    expect(metrics.commitFirstTryRejections ?? 0).toBe(0);
    expect(metrics.hookFailureReflows ?? 0).toBe(0);
  });

  it('lint 回流计入 commitFirstTryRejections 与 hookFailureReflows，重试成功不再计首试通过', async () => {
    const lintFailure =
      'Worktree commit 失败:\nsrc/index.ts\n  2:7  error  no-unused-vars\n✖ 3 problems (3 errors, 0 warnings)';
    const commitAndPush = vi
      .fn()
      .mockRejectedValueOnce(new Error(lintFailure))
      .mockResolvedValue(undefined);
    const worktreeManager = createMockWorktreeManager({ commitAndPush });
    const brain = createMockBrain({
      recheckAlreadyFixed: vi
        .fn()
        .mockResolvedValue({ alreadyFixed: false, reason: '校验错误仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
      {
        toolCalls: [
          {
            id: '3',
            name: 'write_file',
            input: { relPath: 'src/index.ts', content: 'lint-fixed' },
          },
        ],
      },
      { toolCalls: [{ id: '4', name: 'finish', input: { success: true, reason: 'lint done' } }] },
    ]);
    const metrics = createMetrics();
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
      metrics,
    });

    const result = await actor.executeBatchFix(
      mockMR,
      [{ finding: mockFinding, fileContent: 'const unused = 1;' }],
      'Reviewer 要求删除未使用变量'
    );

    expect(result.success).toBe(true);
    expect(metrics.commitFirstTryRejections).toBe(1);
    expect(metrics.hookFailureReflows).toBe(1);
    expect(metrics.commitFirstTryPasses ?? 0).toBe(0);
  });

  it('ask 门禁拦截计入 askGateInterceptions', async () => {
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    const metrics = createMetrics();
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
      metrics,
    });
    const decision: CognitiveDecision = {
      action: 'ask',
      reason: '需要文件内容才能分析',
      question: '请提供 src/index.ts 文件的内容，以便分析当前实现。',
      analysis: '缺少文件内容',
      consideredOptions: ['索要文件'],
      reasoning: '没有文件无法分析',
      confidence: 'low',
    };

    const result = await actor.applyDecision(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(true);
    expect(metrics.askGateInterceptions).toBe(1);
  });

  it('未注入 metrics 时指标路径静默跳过（兼容旧调用方）', async () => {
    const worktreeManager = createMockWorktreeManager();
    const brain = createMockBrain({
      recheckAlreadyFixed: vi.fn().mockResolvedValue({ alreadyFixed: false, reason: '问题仍存在' }),
    });
    const llmClient = createMockLlmClient([
      {
        toolCalls: [
          { id: '1', name: 'write_file', input: { relPath: 'src/index.ts', content: 'fixed' } },
        ],
      },
      { toolCalls: [{ id: '2', name: 'finish', input: { success: true, reason: 'done' } }] },
    ]);
    const actor = new MaintainerActor({
      provider: createMockProvider(),
      llmClient,
      worktreeManager,
      brain,
      maintainerName: 'Maintainer',
    });
    const decision: CognitiveDecision = {
      action: 'fix',
      reason: '删除未使用变量',
      fixDescription: '删除未使用变量',
      analysis: '存在未使用变量',
      consideredOptions: ['删除'],
      reasoning: '删除更干净',
      confidence: 'high',
    };

    const result = await actor.executeFix(
      mockMR,
      mockDiscussion,
      mockFinding,
      decision,
      createState()
    );

    expect(result.codeApplied).toBe(true);
  });
});
