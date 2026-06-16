import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Project, WatchedEvent, KnowledgeEntry, ArchiveAction } from '../types';

/**
 * SQLite 元数据存储封装
 */
export class MetadataStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf-8'));
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const hasArchiveRoot = columns.some((c) => c.name === 'archive_root');
    if (!hasArchiveRoot) {
      this.db.exec('ALTER TABLE projects ADD COLUMN archive_root TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- 项目 ----------

  registerProject(project: Project): void {
    const stmt = this.db.prepare(
      `INSERT INTO projects (id, root_path, archive_root, name, registered_at, last_scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         archive_root = excluded.archive_root,
         name = excluded.name`
    );
    stmt.run(project.id, project.rootPath, project.archiveRoot ?? null, project.name, project.registeredAt, project.lastScannedAt);
  }

  unregisterProject(projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    this.db.prepare('DELETE FROM watch_events WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM categories WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM archive_actions WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM action_history WHERE project_id = ?').run(projectId);
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY registered_at DESC').all() as Array<{
      id: string;
      root_path: string;
      archive_root: string | null;
      name: string;
      registered_at: number;
      last_scanned_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      rootPath: r.root_path,
      archiveRoot: r.archive_root ?? undefined,
      name: r.name,
      registeredAt: r.registered_at,
      lastScannedAt: r.last_scanned_at,
    }));
  }

  getProject(projectId: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | { id: string; root_path: string; archive_root: string | null; name: string; registered_at: number; last_scanned_at: number | null }
      | undefined;
    return r
      ? {
          id: r.id,
          rootPath: r.root_path,
          archiveRoot: r.archive_root ?? undefined,
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

  /**
   * 获取指定项目所有待处理事件的文件路径
   */
  listPendingEventPaths(projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT file_path FROM watch_events WHERE project_id = ? AND processed = 0')
      .all(projectId) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
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

  /**
   * 获取指定项目所有知识条目的文件路径
   */
  listEntryPaths(projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT file_path FROM knowledge_entries WHERE project_id = ?')
      .all(projectId) as Array<{ file_path: string }>;
    return rows.map((r) => r.file_path);
  }

  // ---------- 分类 ----------

  listCategories(projectId: string): Array<{ name: string; description: string }> {
    const rows = this.db
      .prepare('SELECT name, description FROM categories WHERE project_id = ? ORDER BY name')
      .all(projectId) as Array<{ name: string; description: string }>;
    return rows;
  }

  upsertCategory(projectId: string, name: string, description?: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO categories (project_id, name, description)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET
         description = excluded.description`
    );
    stmt.run(projectId, name, description ?? null);
  }

  // ---------- 归档动作 ----------

  insertAction(action: ArchiveAction & { projectId: string }): void {
    const stmt = this.db.prepare(
      `INSERT INTO archive_actions (id, entry_id, project_id, type, reason, target_path, related_entry_id, risk, confidence, executed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    stmt.run(
      action.id,
      action.sourcePath,
      action.projectId,
      action.type,
      action.reason,
      action.targetPath ?? null,
      action.relatedEntryId ?? null,
      action.risk,
      action.confidence,
      action.createdAt
    );
  }

  listPendingActions(projectId: string): Array<ArchiveAction & { projectId: string }> {
    const rows = this.db
      .prepare('SELECT * FROM archive_actions WHERE project_id = ? AND executed = 0 ORDER BY created_at ASC')
      .all(projectId) as Array<{
      id: string;
      entry_id: string;
      project_id: string;
      type: string;
      reason: string;
      target_path: string | null;
      related_entry_id: string | null;
      risk: string;
      confidence: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sourcePath: r.entry_id,
      projectId: r.project_id,
      type: r.type as ArchiveAction['type'],
      reason: r.reason,
      targetPath: r.target_path ?? undefined,
      relatedEntryId: r.related_entry_id ?? undefined,
      risk: r.risk as ArchiveAction['risk'],
      confidence: r.confidence,
      createdAt: r.created_at,
    }));
  }

  markActionsProcessed(actionIds: string[]): void {
    if (actionIds.length === 0) return;
    const placeholders = actionIds.map(() => '?').join(',');
    const now = Date.now();
    this.db.prepare(`UPDATE archive_actions SET executed = 1, executed_at = ? WHERE id IN (${placeholders})`).run(now, ...actionIds);
  }

  // ---------- 动作历史（支持撤销） ----------

  insertActionHistory(action: ArchiveAction & { projectId: string }): void {
    const stmt = this.db.prepare(
      `INSERT INTO action_history (action_id, project_id, type, source_path, target_path, status, applied_at)
       VALUES (?, ?, ?, ?, ?, 'applied', ?)`
    );
    stmt.run(
      action.id,
      action.projectId,
      action.type,
      action.sourcePath,
      action.targetPath ?? null,
      action.createdAt
    );
  }

  getActionHistory(actionId: string): (ArchiveAction & { projectId: string; historyId: number; status: 'applied' | 'undone' }) | null {
    const r = this.db
      .prepare('SELECT * FROM action_history WHERE action_id = ? ORDER BY id DESC LIMIT 1')
      .get(actionId) as
      | {
          id: number;
          action_id: string;
          project_id: string;
          type: string;
          source_path: string;
          target_path: string | null;
          status: string;
          applied_at: number;
        }
      | undefined;
    if (!r) return null;
    return {
      historyId: r.id,
      id: r.action_id,
      projectId: r.project_id,
      sourcePath: r.source_path,
      type: r.type as ArchiveAction['type'],
      targetPath: r.target_path ?? undefined,
      risk: 'low',
      reason: '',
      confidence: 0,
      createdAt: r.applied_at,
      status: r.status as 'applied' | 'undone',
    };
  }

  listActionHistory(projectId: string): Array<ArchiveAction & { projectId: string; historyId: number; status: 'applied' | 'undone' }> {
    const rows = this.db
      .prepare('SELECT * FROM action_history WHERE project_id = ? ORDER BY applied_at DESC')
      .all(projectId) as Array<{
        id: number;
        action_id: string;
        project_id: string;
        type: string;
        source_path: string;
        target_path: string | null;
        status: string;
        applied_at: number;
      }>;
    return rows.map((r) => ({
      historyId: r.id,
      id: r.action_id,
      projectId: r.project_id,
      sourcePath: r.source_path,
      type: r.type as ArchiveAction['type'],
      targetPath: r.target_path ?? undefined,
      risk: 'low',
      reason: '',
      confidence: 0,
      createdAt: r.applied_at,
      status: r.status as 'applied' | 'applied',
    }));
  }

  markHistoryUndone(historyId: number): void {
    this.db
      .prepare('UPDATE action_history SET status = ?, undone_at = ? WHERE id = ?')
      .run('undone', Date.now(), historyId);
  }

  // ---------- 项目统计 ----------

  getProjectCounts(
    projectId: string,
    riskLevels: string[] = ['medium', 'high']
  ): { pending: number; archived: number; ignored: number; suggestion: number } {
    const entryCounts = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
          SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored
         FROM knowledge_entries WHERE project_id = ?`
      )
      .get(projectId) as { pending: number; archived: number; ignored: number };
    const riskPlaceholders = riskLevels.map(() => '?').join(',');
    const suggestion = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM archive_actions WHERE project_id = ? AND executed = 0 AND risk IN (${riskPlaceholders})`
      )
      .get(projectId, ...riskLevels) as { c: number };
    return {
      pending: Number(entryCounts.pending ?? 0),
      archived: Number(entryCounts.archived ?? 0),
      ignored: Number(entryCounts.ignored ?? 0),
      suggestion: Number(suggestion.c ?? 0),
    };
  }
}
