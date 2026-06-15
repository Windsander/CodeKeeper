import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UndoExecutor } from '../../../src/advance/archive/undo-executor';
import { MetadataStore } from '../../../src/advance/store/metadata-store';

describe('UndoExecutor', () => {
  let tmp: string;
  let store: MetadataStore;
  let projectRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-undo-'));
    store = new MetadataStore(join(tmp, 'test.db'));
    projectRoot = mkdtempSync(join(tmp, 'project-'));
    store.registerProject({
      id: projectRoot,
      rootPath: projectRoot,
      name: 'undo-test',
      registeredAt: 1,
      lastScannedAt: null,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('应撤销 move 动作', async () => {
    const source = join(projectRoot, 'a.md');
    const target = join(projectRoot, 'docs', 'a.md');
    writeFileSync(source, 'hello', 'utf-8');
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    // 模拟执行 move
    const { renameSync } = await import('node:fs');
    renameSync(source, target);
    store.upsertEntry({
      id: 'e1',
      projectId: projectRoot,
      filePath: target,
      contentHash: 'h1',
      status: 'archived',
      createdAt: 1,
      updatedAt: 1,
    });

    store.insertActionHistory({
      id: 'm1',
      sourcePath: source,
      projectId: projectRoot,
      type: 'move',
      reason: '归档',
      targetPath: target,
      risk: 'low',
      confidence: 0.9,
      createdAt: 1,
    });

    const executor = new UndoExecutor({ store, projectRoot });
    const result = await executor.undo('m1');
    expect(result.success).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(false);
    const entry = store.listEntriesByProject(projectRoot)[0];
    expect(entry.status).toBe('pending');
  });

  it('应撤销 ignore 动作', async () => {
    const source = join(projectRoot, 'ignore.md');
    writeFileSync(source, 'x', 'utf-8');
    store.upsertEntry({
      id: 'e2',
      projectId: projectRoot,
      filePath: source,
      contentHash: 'h2',
      status: 'ignored',
      createdAt: 1,
      updatedAt: 1,
    });
    store.insertActionHistory({
      id: 'i1',
      sourcePath: source,
      projectId: projectRoot,
      type: 'ignore',
      reason: '忽略',
      risk: 'low',
      confidence: 0.9,
      createdAt: 1,
    });

    const executor = new UndoExecutor({ store, projectRoot });
    const result = await executor.undo('i1');
    expect(result.success).toBe(true);
    const entry = store.listEntriesByProject(projectRoot)[0];
    expect(entry.status).toBe('pending');
  });

  it('重复撤销应失败', async () => {
    const source = join(projectRoot, 'x.md');
    writeFileSync(source, 'x', 'utf-8');
    store.insertActionHistory({
      id: 'u1',
      sourcePath: source,
      projectId: projectRoot,
      type: 'ignore',
      reason: '忽略',
      risk: 'low',
      confidence: 0.9,
      createdAt: 1,
    });

    const executor = new UndoExecutor({ store, projectRoot });
    await executor.undo('u1');
    const second = await executor.undo('u1');
    expect(second.success).toBe(false);
  });

  it('不存在的 action 应失败', async () => {
    const executor = new UndoExecutor({ store, projectRoot });
    const result = await executor.undo('not-exist');
    expect(result.success).toBe(false);
  });
});
