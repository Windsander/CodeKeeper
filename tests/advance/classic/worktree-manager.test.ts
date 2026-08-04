import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  WorktreeManager,
  WorktreeError,
} from '../../../src/advance/classic/worktree/worktree-manager';

const mockClone = vi.fn();
const mockFetch = vi.fn();
const mockCheckoutBranch = vi.fn();
const mockCheckout = vi.fn();
const mockAdd = vi.fn();
const mockCommit = vi.fn();
const mockPush = vi.fn();
const mockStatus = vi.fn();
const mockDeleteLocalBranch = vi.fn();
const mockReset = vi.fn();
const mockClean = vi.fn();
const mockGetConfig = vi.fn();
const mockAddConfig = vi.fn();

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    clone: mockClone,
    fetch: mockFetch,
    checkoutBranch: mockCheckoutBranch,
    checkout: mockCheckout,
    add: mockAdd,
    commit: mockCommit,
    push: mockPush,
    status: mockStatus,
    deleteLocalBranch: mockDeleteLocalBranch,
    reset: mockReset,
    clean: mockClean,
    getConfig: mockGetConfig,
    addConfig: mockAddConfig,
  })),
  CleanOptions: {
    FORCE: 'f',
    RECURSIVE: 'd',
  },
}));

describe('WorktreeManager', () => {
  let tmp: string;
  let rootPath: string;
  let remoteUrl: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-wt-'));
    rootPath = join(tmp, 'project');
    remoteUrl = 'https://git.example.com/group/project.git';
    vi.clearAllMocks();
    mockGetConfig.mockResolvedValue({ value: '' });
    mockStatus.mockResolvedValue({ files: [] });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应解析出正确的 worktree 路径', () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    expect(manager.getWorktreePath()).toBe(join(tmp, '.codekeeper-worktree', 'p1'));
  });

  it('ensureWorktree 首次应 clone 远程仓库', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    await manager.ensureWorktree();

    expect(mockClone).toHaveBeenCalledOnce();
    expect(mockClone).toHaveBeenCalledWith(remoteUrl, manager.getWorktreePath(), [
      '--origin',
      'origin',
    ]);
  });

  it('ensureWorktree 已存在时应 fetch 更新', async () => {
    mkdirSync(join(tmp, '.codekeeper-worktree', 'p1', '.git'), { recursive: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    await manager.ensureWorktree();

    expect(mockClone).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith('origin');
  });

  it('createFixBranch 应基于源分支切出修复分支', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    const sourceBranch = 'main';
    const branchName = await manager.createFixBranch(sourceBranch);

    expect(mockFetch).toHaveBeenCalledWith('origin', sourceBranch);
    expect(mockCheckoutBranch).toHaveBeenCalledOnce();
    expect(mockCheckoutBranch).toHaveBeenCalledWith(
      expect.stringMatching(/^codekeeper-fix\/main-\d+$/),
      'origin/main'
    );
    expect(branchName).toMatch(/^codekeeper-fix\/main-\d+$/);
  });

  it('readFile/writeFile 应操作 worktree 内文件', () => {
    const worktreePath = join(tmp, '.codekeeper-worktree', 'p1');
    mkdirSync(worktreePath, { recursive: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });

    manager.writeFile('src/fix.ts', '// fixed');
    expect(existsSync(join(worktreePath, 'src', 'fix.ts'))).toBe(true);
    expect(manager.readFile('src/fix.ts')).toBe('// fixed');
  });

  it('writeFile mode=append 应追加到文件末尾', () => {
    const worktreePath = join(tmp, '.codekeeper-worktree', 'p1');
    mkdirSync(worktreePath, { recursive: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });

    manager.writeFile('src/big.ts', 'part1\n');
    manager.writeFile('src/big.ts', 'part2\n', 'append');
    manager.writeFile('src/big.ts', 'part3\n', 'append');
    expect(manager.readFile('src/big.ts')).toBe('part1\npart2\npart3\n');

    // overwrite 应重新覆盖
    manager.writeFile('src/big.ts', 'reset\n');
    expect(manager.readFile('src/big.ts')).toBe('reset\n');
  });

  it('commitAndPush 有变更时应 add/commit/push', async () => {
    mockStatus.mockResolvedValueOnce({ files: [{ path: 'src/fix.ts' }] });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    const branchName = 'codekeeper-fix/main-123';
    await manager.commitAndPush(branchName, 'fix: 修复问题');

    expect(mockAdd).toHaveBeenCalledWith('.');
    expect(mockCommit).toHaveBeenCalledWith('fix: 修复问题');
    expect(mockPush).toHaveBeenCalledWith('origin', branchName, ['--set-upstream']);
  });

  it('commitAndPush 无变更时应跳过提交', async () => {
    mockStatus.mockResolvedValueOnce({ files: [] });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    await manager.commitAndPush('codekeeper-fix/main-123', 'fix: 修复问题');

    expect(mockAdd).toHaveBeenCalledWith('.');
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('cleanupBranch 应强制删除本地分支', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    await manager.cleanupBranch('codekeeper-fix/main-123');

    expect(mockDeleteLocalBranch).toHaveBeenCalledWith('codekeeper-fix/main-123', true);
  });

  it('cleanupBranch 删除失败时不应抛出', async () => {
    mockDeleteLocalBranch.mockRejectedValueOnce(new Error('branch not found'));
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    await expect(manager.cleanupBranch('codekeeper-fix/main-123')).resolves.toBeUndefined();
  });

  it('validate 应在 worktree 目录下运行 lint 和 typecheck', async () => {
    const worktreePath = join(tmp, '.codekeeper-worktree', 'p1');
    const runScript = vi.fn(async (script: string, cwd: string) => {
      expect(cwd).toBe(worktreePath);
      if (script === 'lint' || script === 'typecheck') {
        return { success: true };
      }
      return { success: false };
    });

    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      runScript,
    });
    const result = await manager.validate();

    expect(result.lint).toBe(true);
    expect(result.typecheck).toBe(true);
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript).toHaveBeenCalledWith('lint', worktreePath);
    expect(runScript).toHaveBeenCalledWith('typecheck', worktreePath);
  });

  it('checkoutBranch 应先重置并清理本地变更', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
    });
    await manager.checkoutBranch('feature/foo');

    expect(mockFetch).toHaveBeenCalledWith('origin', 'feature/foo');
    expect(mockReset).toHaveBeenCalledWith(['--hard']);
    expect(mockClean).toHaveBeenCalledWith(['f', 'd']);
    expect(mockCheckout).toHaveBeenCalledWith(['-B', 'feature/foo', 'origin/feature/foo']);
  });

  it('ensureWorktree 首次 clone 后应配置 git 用户', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      gitUserName: 'Agent',
      gitUserEmail: 'agent@example.com',
    });
    await manager.ensureWorktree();

    expect(mockClone).toHaveBeenCalledOnce();
    expect(mockAddConfig).toHaveBeenCalledWith('user.name', 'Agent', false, 'local');
    expect(mockAddConfig).toHaveBeenCalledWith('user.email', 'agent@example.com', false, 'local');
  });

  it('prepareEnvironment 应在 node_modules 缺失时安装依赖', async () => {
    mkdirSync(join(tmp, '.codekeeper-worktree', 'p1'), { recursive: true });
    writeFileSync(join(tmp, '.codekeeper-worktree', 'p1', 'package.json'), '{}');
    const install = vi.fn().mockResolvedValue({ success: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      install,
    });

    await manager.prepareEnvironment();

    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(manager.getWorktreePath());
  });

  it('prepareEnvironment 安装失败时应抛出 WorktreeError', async () => {
    mkdirSync(join(tmp, '.codekeeper-worktree', 'p1'), { recursive: true });
    writeFileSync(join(tmp, '.codekeeper-worktree', 'p1', 'package.json'), '{}');
    const install = vi.fn().mockResolvedValue({ success: false, reason: 'network error' });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      install,
    });

    await expect(manager.prepareEnvironment()).rejects.toThrow(WorktreeError);
  });

  it('prepareEnvironment 存在 compile:packages 脚本时应编译 workspace 包', async () => {
    mkdirSync(join(tmp, '.codekeeper-worktree', 'p1'), { recursive: true });
    writeFileSync(
      join(tmp, '.codekeeper-worktree', 'p1', 'package.json'),
      JSON.stringify({ scripts: { 'compile:packages': 'npm run build -w pkg' } })
    );
    const install = vi.fn().mockResolvedValue({ success: true });
    const runScript = vi.fn().mockResolvedValue({ success: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      install,
      runScript,
    });

    await manager.prepareEnvironment();

    expect(install).toHaveBeenCalledOnce();
    expect(runScript).toHaveBeenCalledWith('compile:packages', manager.getWorktreePath());
  });

  it('prepareEnvironment 修复模式应保留基线编译失败并继续', async () => {
    mkdirSync(join(tmp, '.codekeeper-worktree', 'p1'), { recursive: true });
    writeFileSync(
      join(tmp, '.codekeeper-worktree', 'p1', 'package.json'),
      JSON.stringify({ scripts: { 'compile:packages': 'npm run build' } })
    );
    const install = vi.fn().mockResolvedValue({ success: true });
    const runScript = vi.fn().mockResolvedValue({
      success: false,
      reason: 'src/module.ts(12,3): error TS2305: missing export',
    });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      install,
      runScript,
    });

    const result = await manager.prepareEnvironment({ allowCompileFailure: true });

    expect(result.compilePackagesFailure).toContain('error TS2305');
  });

  it('listChangedFiles 应返回 git status 中的权威变更', async () => {
    mockStatus.mockResolvedValue({
      files: [
        { path: 'src/a.ts', index: 'M', working_dir: ' ' },
        { path: 'virtual/module-b.ts', index: 'D', working_dir: ' ' },
      ],
    });
    const manager = new WorktreeManager({ projectId: 'p1', rootPath, remoteUrl });

    await expect(manager.listChangedFiles()).resolves.toEqual([
      { path: 'src/a.ts', deleted: false },
      { path: 'virtual/module-b.ts', deleted: true },
    ]);
  });

  it('runScript 应透传 args 参数', async () => {
    mkdirSync(join(tmp, '.codekeeper-worktree', 'p1'), { recursive: true });
    const runScript = vi.fn().mockResolvedValue({ success: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl,
      runScript,
    });

    await manager.runScript('test', ['packages/foo/src/bar.test.ts']);

    expect(runScript).toHaveBeenCalledWith('test', manager.getWorktreePath(), [
      'packages/foo/src/bar.test.ts',
    ]);
  });
});
