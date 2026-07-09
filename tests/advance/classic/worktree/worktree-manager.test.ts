import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager, WorktreeError } from '../../../../src/advance/classic/worktree/worktree-manager.js';

describe('WorktreeManager.validate', () => {
  it('返回 lint/typecheck 失败原因', async () => {
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath: '/tmp/p1',
      remoteUrl: 'https://example.com/p1.git',
      runScript: async (script) =>
        script === 'lint'
          ? { success: false, reason: 'eslint error' }
          : { success: true },
    });

    const result = await manager.validate();
    expect(result.lint).toBe(false);
    expect(result.typecheck).toBe(true);
    expect(result.lintReason).toBe('eslint error');
  });

  it('runScript 委托给注入的运行器', async () => {
    const runScript = vi.fn().mockResolvedValue({ success: true });
    const manager = new WorktreeManager({
      projectId: 'p1',
      rootPath: '/tmp/p1',
      remoteUrl: 'https://example.com/p1.git',
      runScript,
    });

    const result = await manager.runScript('compile:packages');

    expect(result.success).toBe(true);
    expect(runScript).toHaveBeenCalledWith('compile:packages', expect.any(String));
  });
});

describe('WorktreeError', () => {
  it('包含 stage 信息', () => {
    const err = new WorktreeError('checkout', new Error('branch not found'));
    expect(err.stage).toBe('checkout');
    expect(err.message).toContain('branch not found');
  });
});

describe('WorktreeManager 流式读取', () => {
  let tempDir: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wt-test-'));
    const rootPath = join(tempDir, 'project');
    mkdirSync(rootPath, { recursive: true });
    const worktreePath = join(tempDir, '.codekeeper-worktree', 'p1');
    mkdirSync(worktreePath, { recursive: true });
    manager = new WorktreeManager({
      projectId: 'p1',
      rootPath,
      remoteUrl: 'https://example.com/p1.git',
    });
    const filePath = join(worktreePath, 'src/index.ts');
    mkdirSync(join(worktreePath, 'src'), { recursive: true });
    writeFileSync(
      filePath,
      "import { foo } from './foo';\n\nfunction a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\n",
      'utf-8'
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('readFileWindow 返回聚焦上下文', async () => {
    const focused = await manager.readFileWindow('src/index.ts', {
      file: 'src/index.ts',
      line: 4,
      severity: 'MEDIUM',
      message: '',
      suggestion: '',
    });
    expect(focused.totalLines).toBe(5);
    expect(focused.snippet).toContain('function b');
    expect(focused.imports).toContain("import { foo } from './foo';");
  });

  it('readFileRange 返回范围内容', async () => {
    const content = await manager.readFileRange('src/index.ts', 3, 4);
    expect(content).toContain('function a');
    expect(content).toContain('function b');
  });

  it('getFileOverview 返回概览', async () => {
    const overview = await manager.getFileOverview('src/index.ts');
    expect(overview.lineCount).toBe(5);
    expect(overview.symbols.map((s) => s.name)).toContain('a');
    expect(overview.symbols.map((s) => s.name)).toContain('b');
    expect(overview.symbols.map((s) => s.name)).toContain('c');
  });

  it('searchInFile 返回匹配范围', async () => {
    const ranges = await manager.searchInFile('src/index.ts', 'function b');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startLine).toBe(4);
  });

  it('readFile 仍对超大文件抛错', () => {
    const bigFile = join(tempDir, '.codekeeper-worktree', 'p1', 'big.txt');
    writeFileSync(bigFile, 'x'.repeat(600 * 1024), 'utf-8');
    expect(() => manager.readFile('big.txt')).toThrow('过大');
  });
});
