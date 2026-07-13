import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from '../../../../src/advance/classic/fix/tools/tool-executor.js';
import type { WorktreeManager } from '../../../../src/advance/classic/worktree/worktree-manager.js';

function createMockWorktreeManager(overrides: Partial<WorktreeManager> = {}): WorktreeManager {
  return {
    resolveFilePath: vi.fn().mockImplementation(async (p: string) => p),
    readFile: vi.fn().mockReturnValue('content'),
    readFileWindow: vi.fn().mockResolvedValue({
      imports: '',
      snippet: 'window-content',
      snippetStartLine: 1,
      snippetEndLine: 1,
      totalLines: 10,
      truncated: true,
      targetLine: 1,
    }),
    readFileRange: vi.fn().mockResolvedValue('range-content'),
    getFileOverview: vi.fn().mockResolvedValue({ lineCount: 100, symbols: [] }),
    searchInFile: vi.fn().mockResolvedValue([{ startLine: 5, endLine: 5 }]),
    writeFile: vi.fn().mockReturnValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
    applyPatch: vi.fn().mockResolvedValue(true),
    runSetupCommand: vi.fn().mockResolvedValue({ success: true }),
    runScript: vi.fn().mockResolvedValue({ success: true }),
    validate: vi.fn().mockResolvedValue({ lint: true, typecheck: true }),
    ...overrides,
  } as unknown as WorktreeManager;
}

describe('ToolExecutor', () => {
  it('read_file 返回文件内容', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({ id: '1', name: 'read_file', input: { relPath: 'src/index.ts' } });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBe('content');
  });

  it('read_file 支持 startLine/endLine', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'read_file',
      input: { relPath: 'src/index.ts', startLine: 10, endLine: 20 },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.content).toBe('range-content');
    expect(worktree.readFileRange).toHaveBeenCalledWith('src/index.ts', 10, 20);
  });

  it('read_file 支持 targetLine', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'read_file',
      input: { relPath: 'src/index.ts', targetLine: 15, windowLines: 20 },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.content).toBe('window-content');
    expect(worktree.readFileWindow).toHaveBeenCalled();
  });

  it('get_file_overview 返回概览', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'get_file_overview',
      input: { relPath: 'src/index.ts' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.lineCount).toBe(100);
  });

  it('search_in_file 返回匹配范围', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'search_in_file',
      input: { relPath: 'src/index.ts', keyword: 'foo' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual([{ startLine: 5, endLine: 5 }]);
  });

  it('write_file 调用 worktreeManager.writeFile', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'write_file',
      input: { relPath: 'src/index.ts', content: 'new' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.unchanged).toBe(false);
    expect(worktree.writeFile).toHaveBeenCalledWith('src/index.ts', 'new');
  });

  it('write_file 检测到无变更时返回 unchanged=true', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'write_file',
      input: { relPath: 'src/index.ts', content: 'content' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.unchanged).toBe(true);
  });

  it('run_script 白名单外返回错误', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree, allowedScripts: ['lint'] });

    const result = await executor.execute({
      id: '1',
      name: 'run_script',
      input: { script: 'evil' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('不在白名单');
  });

  it('run_script 白名单内可执行', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree, allowedScripts: ['lint'] });

    const result = await executor.execute({
      id: '1',
      name: 'run_script',
      input: { script: 'lint' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(worktree.runScript).toHaveBeenCalledWith('lint');
  });

  it('run_setup_command 执行被允许的命令', async () => {
    const worktree = createMockWorktreeManager({
      runSetupCommand: vi.fn().mockResolvedValue({ success: true }),
    });
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'run_setup_command',
      input: { command: 'npm install' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data.success).toBe(true);
    expect(worktree.runSetupCommand).toHaveBeenCalledWith('npm install', undefined);
  });

  it('run_setup_command 拦截危险命令', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({
      id: '1',
      name: 'run_setup_command',
      input: { command: 'rm -rf /' },
    });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('安全策略');
  });

  it('validate 返回校验结果', async () => {
    const worktree = createMockWorktreeManager();
    const executor = new ToolExecutor({ worktreeManager: worktree });

    const result = await executor.execute({ id: '1', name: 'validate', input: {} });

    const parsed = JSON.parse(result.content);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ lint: true, typecheck: true });
  });
});
