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
    // 旧版 projects 表缺少 archive_root 列
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const hasArchiveRoot = projectColumns.some((c) => c.name === 'archive_root');
    if (!hasArchiveRoot) {
      this.db.exec('ALTER TABLE projects ADD COLUMN archive_root TEXT');
    }

    // 若旧表仍带有 ('move','merge','create',...) 的 CHECK 约束，需要重建表才能迁移类型
    this.rebuildActionTablesIfNeeded();

    // archive_actions 新增 source_path / archive_path
    const actionColumns = this.db.prepare("PRAGMA table_info(archive_actions)").all() as Array<{ name: string }>;
    if (!actionColumns.some((c) => c.name === 'source_path')) {
      this.db.exec('ALTER TABLE archive_actions ADD COLUMN source_path TEXT');
    }
    if (!actionColumns.some((c) => c.name === 'archive_path')) {
      this.db.exec('ALTER TABLE archive_actions ADD COLUMN archive_path TEXT');
    }

    // action_history 新增 archive_path
    const historyColumns = this.db.prepare("PRAGMA table_info(action_history)").all() as Array<{ name: string }>;
    if (!historyColumns.some((c) => c.name === 'archive_path')) {
      this.db.exec('ALTER TABLE action_history ADD COLUMN archive_path TEXT');
    }

    // archive_metadata 新增 type 列
    const metadataColumns = this.db.prepare("PRAGMA table_info(archive_metadata)").all() as Array<{ name: string }>;
    if (!metadataColumns.some((c) => c.name === 'type')) {
      this.db.exec('ALTER TABLE archive_metadata ADD COLUMN type TEXT NOT NULL DEFAULT \'copy\'');
    }

    // 创建 archive_metadata 表（主表）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_metadata (
        entry_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        category TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        content_hash TEXT NOT NULL,
        copied_at INTEGER NOT NULL,
        organized_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'orphaned', 'superseded')),
        FOREIGN KEY (entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_project ON archive_metadata(project_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_category ON archive_metadata(category);
      CREATE INDEX IF NOT EXISTS idx_metadata_doc_type ON archive_metadata(doc_type);
      CREATE INDEX IF NOT EXISTS idx_metadata_status ON archive_metadata(status);
    `);

    // 旧版 action_history 中 move/create/merge 类型迁移到新语义
    this.db.exec(`
      UPDATE action_history SET type = 'copy' WHERE type IN ('move', 'create');
      UPDATE action_history SET type = 'organize' WHERE type = 'merge';
    `);
  }

  private rebuildActionTablesIfNeeded(): void {
    const tables = this.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('archive_actions', 'action_history')")
      .all() as Array<{ name: string; sql: string }>;

    for (const { name, sql } of tables) {
      if (sql && sql.includes("'move'")) {
        const isActions = name === 'archive_actions';
        const tempName = `${name}_new`;
        this.db.exec(`DROP TABLE IF EXISTS ${tempName}`);
        if (isActions) {
          this.db.exec(`
            CREATE TABLE ${tempName} (
              id TEXT PRIMARY KEY,
              entry_id TEXT NOT NULL,
              project_id TEXT NOT NULL,
              type TEXT NOT NULL,
              reason TEXT NOT NULL,
              source_path TEXT,
              archive_path TEXT,
              target_path TEXT,
              related_entry_id TEXT,
              risk TEXT NOT NULL,
              confidence REAL NOT NULL,
              executed INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              executed_at INTEGER
            );
          `);
          this.db.exec(`
            INSERT INTO ${tempName} (
              id, entry_id, project_id, type, reason, source_path, archive_path,
              target_path, related_entry_id, risk, confidence, executed, created_at, executed_at
            )
            SELECT
              id, entry_id, project_id, type, reason, source_path, archive_path,
              target_path, related_entry_id, risk, confidence, executed, created_at, executed_at
            FROM ${name};
          `);
        } else {
          this.db.exec(`
            CREATE TABLE ${tempName} (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              action_id TEXT NOT NULL,
              project_id TEXT NOT NULL,
              type TEXT NOT NULL,
              source_path TEXT NOT NULL,
              archive_path TEXT,
              target_path TEXT,
              status TEXT NOT NULL DEFAULT 'applied',
              applied_at INTEGER NOT NULL,
              undone_at INTEGER
            );
          `);
          this.db.exec(`
            INSERT INTO ${tempName} (
              id, action_id, project_id, type, source_path, archive_path,
              target_path, status, applied_at, undone_at
            )
            SELECT
              id, action_id, project_id, type, source_path, archive_path,
              target_path, status, applied_at, undone_at
            FROM ${name};
          `);
        }
        this.db.exec(`DROP TABLE ${name}`);
        this.db.exec(`ALTER TABLE ${tempName} RENAME TO ${name}`);
        // 重建索引
        if (isActions) {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_actions_project ON ${name}(project_id)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_actions_executed ON ${name}(executed)`);
        } else {
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_project ON ${name}(project_id)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_action ON ${name}(action_id)`);
          this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_status ON ${name}(status)`);
        }
      }
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
    this.db.prepare('DELETE FROM archive_metadata WHERE project_id = ?').run(projectId);
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
      `INSERT INTO archive_actions (id, entry_id, project_id, type, reason, source_path, archive_path, target_path, related_entry_id, risk, confidence, executed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    stmt.run(
      action.id,
      action.sourcePath,
      action.projectId,
      action.type,
      action.reason,
      action.sourcePath,
      action.targetPath ?? null,
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
      source_path: string | null;
      archive_path: string | null;
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
      targetPath: r.archive_path ?? r.target_path ?? undefined,
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
      `INSERT INTO action_history (action_id, project_id, type, source_path, archive_path, target_path, status, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, 'applied', ?)`
    );
    stmt.run(
      action.id,
      action.projectId,
      action.type,
      action.sourcePath,
      action.targetPath ?? null,
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
          archive_path: string | null;
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
      targetPath: r.archive_path ?? r.target_path ?? undefined,
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
        archive_path: string | null;
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
      targetPath: r.archive_path ?? r.target_path ?? undefined,
      risk: 'low',
      reason: '',
      confidence: 0,
      createdAt: r.applied_at,
      status: r.status as 'applied' | 'undone',
    }));
  }

  markHistoryUndone(historyId: number): void {
    this.db
      .prepare('UPDATE action_history SET status = ?, undone_at = ? WHERE id = ?')
      .run('undone', Date.now(), historyId);
  }

  // ---------- 项目统计 ----------

  getProjectCounts(
    projectId: string
  ): { pending: number; archived: number; ignored: number; orphaned: number; copied: number; organized: number; flagged: number } {
    const entryCounts = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
          SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored,
          SUM(CASE WHEN status = 'orphaned' THEN 1 ELSE 0 END) AS orphaned
         FROM knowledge_entries WHERE project_id = ?`
      )
      .get(projectId) as { pending: number; archived: number; ignored: number; orphaned: number };

    const metadataCounts = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN type = 'copy' THEN 1 ELSE 0 END) AS copied,
          SUM(CASE WHEN type = 'organize' THEN 1 ELSE 0 END) AS organized,
          SUM(CASE WHEN type = 'flag' THEN 1 ELSE 0 END) AS flagged
         FROM archive_metadata WHERE project_id = ? AND status = 'active'`
      )
      .get(projectId) as { copied: number; organized: number; flagged: number };

    return {
      pending: Number(entryCounts.pending ?? 0),
      archived: Number(entryCounts.archived ?? 0),
      ignored: Number(entryCounts.ignored ?? 0),
      orphaned: Number(entryCounts.orphaned ?? 0),
      copied: Number(metadataCounts.copied ?? 0),
      organized: Number(metadataCounts.organized ?? 0),
      flagged: Number(metadataCounts.flagged ?? 0),
    };
  }

  // ---------- 归档元数据 ----------

  upsertArchiveMetadata(meta: {
    entryId: string;
    projectId: string;
    sourcePath: string;
    archivePath: string;
    category: string;
    docType: string;
    tags: string[];
    summary: string;
    contentHash: string;
    copiedAt: number;
    organizedAt?: number;
    status: 'active' | 'orphaned' | 'superseded';
    type: 'copy' | 'organize' | 'flag';
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO archive_metadata (
        entry_id, project_id, source_path, archive_path, category, doc_type,
        tags, summary, content_hash, type, copied_at, organized_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        archive_path = excluded.archive_path,
        category = excluded.category,
        doc_type = excluded.doc_type,
        tags = excluded.tags,
        summary = excluded.summary,
        content_hash = excluded.content_hash,
        type = excluded.type,
        organized_at = excluded.organized_at,
        status = excluded.status`
    );
    stmt.run(
      meta.entryId,
      meta.projectId,
      meta.sourcePath,
      meta.archivePath,
      meta.category,
      meta.docType,
      JSON.stringify(meta.tags),
      meta.summary,
      meta.contentHash,
      meta.type,
      meta.copiedAt,
      meta.organizedAt ?? null,
      meta.status
    );
  }

  getArchiveMetadata(entryId: string): {
    entryId: string;
    projectId: string;
    sourcePath: string;
    archivePath: string;
    category: string;
    docType: string;
    tags: string[];
    summary: string;
    contentHash: string;
    copiedAt: number;
    organizedAt: number | null;
    status: 'active' | 'orphaned' | 'superseded';
    type: 'copy' | 'organize' | 'flag';
  } | null {
    const r = this.db.prepare('SELECT * FROM archive_metadata WHERE entry_id = ?').get(entryId) as
      | {
          entry_id: string;
          project_id: string;
          source_path: string;
          archive_path: string;
          category: string;
          doc_type: string;
          tags: string;
          summary: string;
          content_hash: string;
          type: string;
          copied_at: number;
          organized_at: number | null;
          status: string;
        }
      | undefined;
    if (!r) return null;
    return {
      entryId: r.entry_id,
      projectId: r.project_id,
      sourcePath: r.source_path,
      archivePath: r.archive_path,
      category: r.category,
      docType: r.doc_type,
      tags: safeParseJsonArray(r.tags),
      summary: r.summary,
      contentHash: r.content_hash,
      copiedAt: r.copied_at,
      organizedAt: r.organized_at,
      status: r.status as 'active' | 'orphaned' | 'superseded',
      type: r.type as 'copy' | 'organize' | 'flag',
    };
  }

  listArchiveMetadataByProject(projectId: string): Array<{
    entryId: string;
    projectId: string;
    sourcePath: string;
    archivePath: string;
    category: string;
    docType: string;
    tags: string[];
    summary: string;
    contentHash: string;
    copiedAt: number;
    organizedAt: number | null;
    status: 'active' | 'orphaned' | 'superseded';
    type: 'copy' | 'organize' | 'flag';
  }> {
    const rows = this.db
      .prepare('SELECT * FROM archive_metadata WHERE project_id = ? ORDER BY archive_path')
      .all(projectId) as Array<{
        entry_id: string;
        project_id: string;
        source_path: string;
        archive_path: string;
        category: string;
        doc_type: string;
        tags: string;
        summary: string;
        content_hash: string;
        type: string;
        copied_at: number;
        organized_at: number | null;
        status: string;
      }>;
    return rows.map((r) => ({
      entryId: r.entry_id,
      projectId: r.project_id,
      sourcePath: r.source_path,
      archivePath: r.archive_path,
      category: r.category,
      docType: r.doc_type,
      tags: safeParseJsonArray(r.tags),
      summary: r.summary,
      contentHash: r.content_hash,
      copiedAt: r.copied_at,
      organizedAt: r.organized_at,
      status: r.status as 'active' | 'orphaned' | 'superseded',
      type: r.type as 'copy' | 'organize' | 'flag',
    }));
  }

  updateArchiveMetadataStatus(
    entryId: string,
    status: 'active' | 'orphaned' | 'superseded'
  ): void {
    this.db
      .prepare('UPDATE archive_metadata SET status = ? WHERE entry_id = ?')
      .run(status, entryId);
  }

  updateArchiveMetadataPath(entryId: string, archivePath: string, organizedAt: number): void {
    this.db
      .prepare('UPDATE archive_metadata SET archive_path = ?, organized_at = ? WHERE entry_id = ?')
      .run(archivePath, organizedAt, entryId);
  }
}

function safeParseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
