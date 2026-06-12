import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetadataStore } from '../../../src/advance/store/metadata-store';

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
});
