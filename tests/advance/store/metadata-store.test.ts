import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../../../src/advance/store/metadata-store';
import type { ArchiveAction } from '../../../src/advance/types';

describe('MetadataStore', () => {
  let store: MetadataStore;
  let dbPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'ck-store-'));
    dbPath = join(dir, 'test.db');
    store = new MetadataStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it('能注册并查询项目', () => {
    store.registerProject({
      id: '/tmp/proj-a',
      rootPath: '/tmp/proj-a',
      name: 'proj-a',
      registeredAt: 1,
      lastScannedAt: null,
    });
    const projects = store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('proj-a');
  });

  it('注销项目会级联删除事件与条目', () => {
    store.registerProject({ id: '/tmp/proj-b', rootPath: '/tmp/proj-b', name: 'proj-b', registeredAt: 1, lastScannedAt: null });
    store.insertEvent({ projectId: '/tmp/proj-b', filePath: '/tmp/proj-b/readme.md', type: 'add', timestamp: 2 });
    store.upsertEntry({
      id: '/tmp/proj-b/readme.md@v1',
      projectId: '/tmp/proj-b',
      filePath: '/tmp/proj-b/readme.md',
      contentHash: 'abc',
      status: 'pending',
      createdAt: 3,
      updatedAt: 3,
    });
    store.unregisterProject('/tmp/proj-b');
    expect(store.listProjects()).toHaveLength(0);
    expect(store.listPendingEvents()).toHaveLength(0);
    expect(store.listEntriesByProject('/tmp/proj-b')).toHaveLength(0);
  });

  it('能插入并标记处理事件', () => {
    store.registerProject({ id: '/tmp/proj-c', rootPath: '/tmp/proj-c', name: 'proj-c', registeredAt: 1, lastScannedAt: null });
    store.insertEvent({ projectId: '/tmp/proj-c', filePath: '/tmp/proj-c/a.md', type: 'change', timestamp: 2 });
    const pending = store.listPendingEvents();
    expect(pending).toHaveLength(1);
    store.markEventsProcessed([pending[0].eventId]);
    expect(store.listPendingEvents()).toHaveLength(0);
  });

  it('应支持分类的增查', () => {
    const project = { id: 'p3', rootPath: '/tmp/proj-d', name: 'proj-d', registeredAt: 1, lastScannedAt: null };
    store.registerProject(project);

    store.upsertCategory(project.id, 'memory', '记忆模块相关');
    expect(store.listCategories(project.id)).toEqual([{ name: 'memory', description: '记忆模块相关' }]);
  });

  it('应支持归档动作的插入与标记处理', () => {
    const project = { id: 'p3', rootPath: '/tmp/proj-d', name: 'proj-d', registeredAt: 1, lastScannedAt: null };
    store.registerProject(project);

    const action: ArchiveAction & { projectId: string } = {
      id: 'a1',
      sourcePath: 'e1',
      projectId: project.id,
      type: 'move',
      reason: '移动到正确目录',
      targetPath: '/target.md',
      risk: 'low',
      confidence: 0.9,
      createdAt: Date.now(),
    };
    store.insertAction(action);
    expect(store.listPendingActions(project.id)).toHaveLength(1);

    store.markActionsProcessed(['a1']);
    expect(store.listPendingActions(project.id)).toHaveLength(0);
  });

  it('应支持动作历史的插入、查询与撤销', () => {
    const project = { id: 'p-history', rootPath: '/tmp/proj-h', name: 'proj-h', registeredAt: 1, lastScannedAt: null };
    store.registerProject(project);

    const action: ArchiveAction & { projectId: string } = {
      id: 'h1',
      sourcePath: '/src.md',
      projectId: project.id,
      type: 'move',
      reason: '移动',
      targetPath: '/dst.md',
      risk: 'low',
      confidence: 0.9,
      createdAt: 1000,
    };
    store.insertActionHistory(action);

    const found = store.getActionHistory('h1');
    expect(found).not.toBeNull();
    expect(found?.type).toBe('move');
    expect(found?.targetPath).toBe('/dst.md');
    expect(found?.status).toBe('applied');

    const list = store.listActionHistory(project.id);
    expect(list).toHaveLength(1);

    store.markHistoryUndone(found!.historyId);
    const undone = store.getActionHistory('h1');
    expect(undone?.status).toBe('undone');
  });

  it('注销项目应级联删除动作历史', () => {
    const project = { id: 'p-h-cascade', rootPath: '/tmp/proj-hc', name: 'proj-hc', registeredAt: 1, lastScannedAt: null };
    store.registerProject(project);
    store.insertActionHistory({
      id: 'hc1',
      sourcePath: '/a.md',
      projectId: project.id,
      type: 'ignore',
      reason: '忽略',
      risk: 'low',
      confidence: 0.9,
      createdAt: 1,
    });
    store.unregisterProject(project.id);
    expect(store.listActionHistory(project.id)).toHaveLength(0);
  });
});
