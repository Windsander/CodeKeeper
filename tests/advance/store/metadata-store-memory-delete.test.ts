import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../../../src/advance/store/metadata-store';

describe('MetadataStore 记忆软删除', () => {
  let dir: string;
  let store: MetadataStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-memory-delete-'));
    store = new MetadataStore(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('markMemorySessionDeleted 记录删除的 session', () => {
    store.markMemorySessionDeleted('p1', 'session-a');
    expect(store.isMemorySessionDeleted('p1', 'session-a')).toBe(true);
    expect(store.isMemorySessionDeleted('p1', 'session-b')).toBe(false);
    expect(store.isMemorySessionDeleted('p2', 'session-a')).toBe(false);
  });

  it('listDeletedMemorySessions 返回项目下所有已删除 session', () => {
    store.markMemorySessionDeleted('p1', 'session-a');
    store.markMemorySessionDeleted('p1', 'session-b');
    store.markMemorySessionDeleted('p2', 'session-c');

    const deleted = store.listDeletedMemorySessions('p1');
    expect(deleted).toContain('session-a');
    expect(deleted).toContain('session-b');
    expect(deleted).not.toContain('session-c');
  });
});
