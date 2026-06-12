import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Project, WatchedEvent, KnowledgeEntry } from '../types';

/**
 * SQLite 元数据存储封装
 */
export class MetadataStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf-8'));
  }

  close(): void {
    this.db.close();
  }

  // ---------- 项目 ----------

  registerProject(project: Project): void {
    const stmt = this.db.prepare(
      `INSERT INTO projects (id, root_path, name, registered_at, last_scanned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         last_scanned_at = excluded.last_scanned_at`
    );
    stmt.run(project.id, project.rootPath, project.name, project.registeredAt, project.lastScannedAt);
  }

  unregisterProject(projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    this.db.prepare('DELETE FROM watch_events WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(projectId);
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY registered_at DESC').all() as Array<{
      id: string;
      root_path: string;
      name: string;
      registered_at: number;
      last_scanned_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      rootPath: r.root_path,
      name: r.name,
      registeredAt: r.registered_at,
      lastScannedAt: r.last_scanned_at,
    }));
  }

  getProject(projectId: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | { id: string; root_path: string; name: string; registered_at: number; last_scanned_at: number | null }
      | undefined;
    return r
      ? {
          id: r.id,
          rootPath: r.root_path,
          name: r.name,
          registeredAt: r.registered_at,
          lastScannedAt: r.last_scanned_at,
        }
      : null;
  }

  updateLastScannedAt(projectId: string, timestamp: number): void {
    this.db.prepare('UPDATE projects SET last_scanned_at = ? WHERE id = ?').run(timestamp, projectId);
  }

  // ---------- 监听事件 ----------

  insertEvent(event: WatchedEvent & { projectId: string }): void {
    const stmt = this.db.prepare(
      `INSERT INTO watch_events (project_id, file_path, event_type, timestamp)
       VALUES (?, ?, ?, ?)`
    );
    stmt.run(event.projectId, event.filePath, event.type, event.timestamp);
  }

  listPendingEvents(limit = 100): Array<WatchedEvent & { projectId: string; eventId: number }> {
    const rows = this.db
      .prepare('SELECT * FROM watch_events WHERE processed = 0 ORDER BY timestamp ASC LIMIT ?')
      .all(limit) as Array<{
      id: number;
      project_id: string;
      file_path: string;
      event_type: string;
      timestamp: number;
    }>;
    return rows.map((r) => ({
      eventId: r.id,
      projectId: r.project_id,
      filePath: r.file_path,
      type: r.event_type as WatchedEvent['type'],
      timestamp: r.timestamp,
    }));
  }

  markEventsProcessed(eventIds: number[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE watch_events SET processed = 1 WHERE id IN (${placeholders})`).run(...eventIds);
  }

  // ---------- 知识条目 ----------

  upsertEntry(entry: KnowledgeEntry): void {
    const stmt = this.db.prepare(
      `INSERT INTO knowledge_entries (id, project_id, file_path, content_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content_hash = excluded.content_hash,
         status = excluded.status,
         updated_at = excluded.updated_at`
    );
    stmt.run(entry.id, entry.projectId, entry.filePath, entry.contentHash, entry.status, entry.createdAt, entry.updatedAt);
  }

  listEntriesByProject(projectId: string): KnowledgeEntry[] {
    const rows = this.db.prepare('SELECT * FROM knowledge_entries WHERE project_id = ?').all(projectId) as Array<{
      id: string;
      project_id: string;
      file_path: string;
      content_hash: string;
      status: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      filePath: r.file_path,
      contentHash: r.content_hash,
      status: r.status as KnowledgeEntry['status'],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
