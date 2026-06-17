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
  let archiveRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cka-undo-'));
    store = new MetadataStore(join(tmp, 'test.db'));
    projectRoot = mkdtempSync(join(tmp, 'project-'));
    archiveRoot = mkdtempSync(join(tmp, 'archive-'));
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

  it('应撤销 copy 动作（删除归档副本）', async () => {
    const source = join(projectRoot, 'a.md');
    const target = join(archiveRoot, 'memory', 'spec', '2024-01', 'a.md');
    writeFileSync(source, 'hello', 'utf-8');
    mkdirSync(join(archiveRoot, 'memory', 'spec', '2024-01'), { recursive: true });
    const { copyFileSync } = await import('node:fs');
    copyFileSync(source, target);
    store.upsertEntry({
      id: 'e1',
      projectId: projectRoot,
      filePath: source,
      contentHash: 'h1',
      status: 'archived',
      createdAt: 1,
      updatedAt: 1,
    });
    store.upsertArchiveMetadata({
      entryId: 'e1',
      projectId: projectRoot,
      sourcePath: source,
      archivePath: target,
      category: 'memory',
      docType: 'spec',
      tags: [],
      summary: '测试',
      contentHash: 'h1',
      copiedAt: 1,
      status: 'active',
      type: 'copy',
    });

    store.insertActionHistory({
      id: 'c1',
      sourcePath: source,
      projectId: projectRoot,
      type: 'copy',
      reason: '归档',
      targetPath: target,
      risk: 'low',
      confidence: 0.9,
      createdAt: 1,
    });

    const executor = new UndoExecutor({ store });
    const result = await executor.undo('c1');
    expect(result.success).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(target)).toBe(false);
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

    const executor = new UndoExecutor({ store });
    const result = await executor.undo('i1');
    expect(result.success).toBe(true);
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

    const executor = new UndoExecutor({ store });
    await executor.undo('u1');
    const second = await executor.undo('u1');
    expect(second.success).toBe(false);
  });

  it('不存在的 action 应失败', async () => {
    const executor = new UndoExecutor({ store });
    const result = await executor.undo('not-exist');
    expect(result.success).toBe(false);
  });
});
