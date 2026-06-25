import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Project, WatchedEvent, KnowledgeEntry, ArchiveAction, GitlabConfig, Role, RoleConfig, RoleFilter, ReviewerConfig } from '../types';

/**
 * SQLite 元数据存储封装
 */
export class MetadataStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // 启用 WAL mode 以支持多进程并发读写；busy_timeout 让写入冲突时自动等待
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 30000;');
    this.db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf-8'));
    this.migrate();
  }

  private migrate(): void {
    // 旧版 projects 表字段迁移
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const hasArchiveRoot = projectColumns.some((c) => c.name === 'archive_root');
    if (!hasArchiveRoot) {
      this.db.exec('ALTER TABLE projects ADD COLUMN archive_root TEXT');
    }
    if (!projectColumns.some((c) => c.name === 'gitlab_config')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN gitlab_config TEXT');
    }
    // mr_review_config 已废弃，迁移到 roles_config
    if (!projectColumns.some((c) => c.name === 'roles_config')) {
      this.db.exec("ALTER TABLE projects ADD COLUMN roles_config TEXT NOT NULL DEFAULT '{}'");
    }

    // 创建 mr_review_states 表（如不存在）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mr_review_states (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mr_iid INTEGER NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        state TEXT NOT NULL,
        title TEXT,
        web_url TEXT,
        findings_json TEXT,
        fix_branch TEXT,
        risk_level TEXT,
        reviewer_comments_count INTEGER DEFAULT 0,
        unresolved_comments_count INTEGER DEFAULT 0,
        ci_status TEXT,
        last_reviewer_comment_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, mr_iid)
      );
      CREATE INDEX IF NOT EXISTS idx_mr_state_project ON mr_review_states(project_id);
      CREATE INDEX IF NOT EXISTS idx_mr_state_state ON mr_review_states(state);
    `);

    // mr_review_states 新增字段
    const mrStateColumns = this.db.prepare("PRAGMA table_info(mr_review_states)").all() as Array<{ name: string }>;
    if (!mrStateColumns.some((c) => c.name === 'posted_discussions_json')) {
      this.db.exec('ALTER TABLE mr_review_states ADD COLUMN posted_discussions_json TEXT');
    }
    if (!mrStateColumns.some((c) => c.name === 'last_review_at')) {
      this.db.exec('ALTER TABLE mr_review_states ADD COLUMN last_review_at INTEGER');
    }

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
      this.db.exec("ALTER TABLE archive_metadata ADD COLUMN type TEXT NOT NULL DEFAULT 'copy'");
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

  private normalizeRoles(raw: unknown): Record<Role, RoleConfig> {
    const defaults: Record<Role, RoleConfig> = {
      reviewer: { role: 'reviewer', enabled: false, reviewSchedule: '*/10 * * * *', learningEnabled: true },
      maintainer: { role: 'maintainer', enabled: false, reviewSchedule: '*/10 * * * *', learningEnabled: true, maintainerName: 'CodeKeeper Maintainer', autoFixEnabled: true, resolveOthersDiscussions: true },
      archiver: { role: 'archiver', enabled: false, reviewSchedule: '0 2 * * *', learningEnabled: true },
    };
    if (!raw || typeof raw !== 'object') return defaults;
    return { ...defaults, ...(raw as Record<Role, RoleConfig>) };
  }

  close(): void {
    this.db.close();
  }

  // ---------- 项目 ----------

  registerProject(project: Project): void {
    const stmt = this.db.prepare(
      `INSERT INTO projects (id, root_path, archive_root, name, registered_at, last_scanned_at, gitlab_config, roles_config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         archive_root = excluded.archive_root,
         name = excluded.name,
         gitlab_config = COALESCE(excluded.gitlab_config, projects.gitlab_config),
         roles_config = COALESCE(excluded.roles_config, projects.roles_config)`
    );
    stmt.run(
      project.id,
      project.rootPath,
      project.archiveRoot ?? null,
      project.name,
      project.registeredAt,
      project.lastScannedAt,
      project.gitlab ? JSON.stringify(project.gitlab) : null,
      project.roles ? JSON.stringify(project.roles) : null
    );
  }

  unregisterProject(projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    this.db.prepare('DELETE FROM watch_events WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM categories WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM archive_actions WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM action_history WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM archive_metadata WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM mr_review_states WHERE project_id = ?').run(projectId);
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY registered_at DESC').all() as Array<{
      id: string;
      root_path: string;
      archive_root: string | null;
      name: string;
      registered_at: number;
      last_scanned_at: number | null;
      gitlab_config: string | null;
      roles_config: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      rootPath: r.root_path,
      archiveRoot: r.archive_root ?? undefined,
      name: r.name,
      registeredAt: r.registered_at,
      lastScannedAt: r.last_scanned_at,
      gitlab: r.gitlab_config ? (JSON.parse(r.gitlab_config) as GitlabConfig) : undefined,
      roles: this.normalizeRoles(JSON.parse(r.roles_config)),
    }));
  }

  getProject(projectId: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | {
          id: string;
          root_path: string;
          archive_root: string | null;
          name: string;
          registered_at: number;
          last_scanned_at: number | null;
          gitlab_config: string | null;
          roles_config: string;
        }
      | undefined;
    return r
      ? {
          id: r.id,
          rootPath: r.root_path,
          archiveRoot: r.archive_root ?? undefined,
          name: r.name,
          registeredAt: r.registered_at,
          lastScannedAt: r.last_scanned_at,
          gitlab: r.gitlab_config ? (JSON.parse(r.gitlab_config) as GitlabConfig) : undefined,
          roles: this.normalizeRoles(JSON.parse(r.roles_config)),
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

  // ---------- MR 自动评审 ----------

  updateProjectGitlabConfig(projectId: string, config: GitlabConfig): void {
    this.db
      .prepare('UPDATE projects SET gitlab_config = ? WHERE id = ?')
      .run(JSON.stringify(config), projectId);
  }

  updateProjectRoleConfig(projectId: string, role: Role, config: RoleConfig): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`项目不存在: ${projectId}`);
    const roles = project.roles ?? this.normalizeRoles({});
    roles[role] = config;
    this.db
      .prepare('UPDATE projects SET roles_config = ? WHERE id = ?')
      .run(JSON.stringify(roles), projectId);
  }

  getRoleEnabledProjects(role: Role): Project[] {
    return this.listProjects().filter(
      (p) => p.gitlab !== null && p.roles?.[role]?.enabled === true
    );
  }

  /** @deprecated 请使用 updateProjectRoleConfig */
  updateMrReviewConfig(projectId: string, mrReview: { enabled: boolean; autoMergeMode: 'full' | 'audit'; reviewSchedule: string; learningEnabled: boolean; maxAutoMergeRisk: 'LOW' | 'MEDIUM' | 'HIGH'; autoFixEnabled?: boolean; resolveOthersDiscussions?: boolean; filter?: unknown }): void {
    // 兼容旧调用方：将 mrReview 配置映射为 reviewer 角色配置
    const reviewerConfig: ReviewerConfig = {
      role: 'reviewer',
      enabled: mrReview.enabled ?? false,
      reviewSchedule: mrReview.reviewSchedule ?? '*/10 * * * *',
      learningEnabled: mrReview.learningEnabled ?? true,
      filter: mrReview.filter as RoleFilter | undefined,
    };
    this.updateProjectRoleConfig(projectId, 'reviewer', reviewerConfig);
  }

  /** @deprecated 请使用 getRoleEnabledProjects */
  getMrEnabledProjects(): Project[] {
    return this.getRoleEnabledProjects('reviewer');
  }

  insertOrUpdateMrState(state: {
    id: string;
    projectId: string;
    mrIid: number;
    sourceBranch: string;
    targetBranch: string;
    state: string;
    title?: string;
    webUrl?: string;
    findingsJson?: string;
    fixBranch?: string;
    riskLevel?: string;
    reviewerCommentsCount: number;
    unresolvedCommentsCount: number;
    ciStatus?: string;
    lastReviewerCommentAt?: number;
    postedDiscussionsJson?: string;
    lastReviewAt?: number;
    createdAt: number;
    updatedAt: number;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO mr_review_states (
        id, project_id, mr_iid, source_branch, target_branch, state, title, web_url,
        findings_json, fix_branch, risk_level, reviewer_comments_count, unresolved_comments_count,
        ci_status, last_reviewer_comment_at, posted_discussions_json, last_review_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, mr_iid) DO UPDATE SET
        source_branch = excluded.source_branch,
        target_branch = excluded.target_branch,
        state = excluded.state,
        title = excluded.title,
        web_url = excluded.web_url,
        findings_json = excluded.findings_json,
        fix_branch = excluded.fix_branch,
        risk_level = excluded.risk_level,
        reviewer_comments_count = excluded.reviewer_comments_count,
        unresolved_comments_count = excluded.unresolved_comments_count,
        ci_status = excluded.ci_status,
        last_reviewer_comment_at = excluded.last_reviewer_comment_at,
        posted_discussions_json = excluded.posted_discussions_json,
        last_review_at = excluded.last_review_at,
        updated_at = excluded.updated_at`
    );
    stmt.run(
      state.id,
      state.projectId,
      state.mrIid,
      state.sourceBranch,
      state.targetBranch,
      state.state,
      state.title ?? null,
      state.webUrl ?? null,
      state.findingsJson ?? null,
      state.fixBranch ?? null,
      state.riskLevel ?? null,
      state.reviewerCommentsCount,
      state.unresolvedCommentsCount,
      state.ciStatus ?? null,
      state.lastReviewerCommentAt ?? null,
      state.postedDiscussionsJson ?? null,
      state.lastReviewAt ?? null,
      state.createdAt,
      state.updatedAt
    );
  }

  getMrState(projectId: string, mrIid: number): {
    id: string;
    projectId: string;
    mrIid: number;
    sourceBranch: string;
    targetBranch: string;
    state: string;
    title?: string;
    webUrl?: string;
    findingsJson?: string;
    fixBranch?: string;
    riskLevel?: string;
    reviewerCommentsCount: number;
    unresolvedCommentsCount: number;
    ciStatus?: string;
    lastReviewerCommentAt?: number;
    postedDiscussionsJson?: string;
    lastReviewAt?: number;
    createdAt: number;
    updatedAt: number;
  } | undefined {
    const r = this.db
      .prepare('SELECT * FROM mr_review_states WHERE project_id = ? AND mr_iid = ?')
      .get(projectId, mrIid) as
      | {
          id: string;
          project_id: string;
          mr_iid: number;
          source_branch: string;
          target_branch: string;
          state: string;
          title: string | null;
          web_url: string | null;
          findings_json: string | null;
          fix_branch: string | null;
          risk_level: string | null;
          reviewer_comments_count: number;
          unresolved_comments_count: number;
          ci_status: string | null;
          last_reviewer_comment_at: number | null;
          posted_discussions_json: string | null;
          last_review_at: number | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      projectId: r.project_id,
      mrIid: r.mr_iid,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      state: r.state,
      title: r.title ?? undefined,
      webUrl: r.web_url ?? undefined,
      findingsJson: r.findings_json ?? undefined,
      fixBranch: r.fix_branch ?? undefined,
      riskLevel: r.risk_level ?? undefined,
      reviewerCommentsCount: r.reviewer_comments_count,
      unresolvedCommentsCount: r.unresolved_comments_count,
      ciStatus: r.ci_status ?? undefined,
      lastReviewerCommentAt: r.last_reviewer_comment_at ?? undefined,
      postedDiscussionsJson: r.posted_discussions_json ?? undefined,
      lastReviewAt: r.last_review_at ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listMrStatesByProject(projectId: string): ReturnType<MetadataStore['getMrState']>[] {
    const rows = this.db
      .prepare('SELECT * FROM mr_review_states WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as Array<{
        id: string;
        project_id: string;
        mr_iid: number;
        source_branch: string;
        target_branch: string;
        state: string;
        title: string | null;
        web_url: string | null;
        findings_json: string | null;
        fix_branch: string | null;
        risk_level: string | null;
        reviewer_comments_count: number;
        unresolved_comments_count: number;
        ci_status: string | null;
        last_reviewer_comment_at: number | null;
        posted_discussions_json: string | null;
        last_review_at: number | null;
        created_at: number;
        updated_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      mrIid: r.mr_iid,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      state: r.state,
      title: r.title ?? undefined,
      webUrl: r.web_url ?? undefined,
      findingsJson: r.findings_json ?? undefined,
      fixBranch: r.fix_branch ?? undefined,
      riskLevel: r.risk_level ?? undefined,
      reviewerCommentsCount: r.reviewer_comments_count,
      unresolvedCommentsCount: r.unresolved_comments_count,
      ciStatus: r.ci_status ?? undefined,
      lastReviewerCommentAt: r.last_reviewer_comment_at ?? undefined,
      postedDiscussionsJson: r.posted_discussions_json ?? undefined,
      lastReviewAt: r.last_review_at ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  listMrStatesByState(state: string): ReturnType<MetadataStore['getMrState']>[] {
    const rows = this.db
      .prepare('SELECT * FROM mr_review_states WHERE state = ? ORDER BY updated_at DESC')
      .all(state) as Array<{
        id: string;
        project_id: string;
        mr_iid: number;
        source_branch: string;
        target_branch: string;
        state: string;
        title: string | null;
        web_url: string | null;
        findings_json: string | null;
        fix_branch: string | null;
        risk_level: string | null;
        reviewer_comments_count: number;
        unresolved_comments_count: number;
        ci_status: string | null;
        last_reviewer_comment_at: number | null;
        posted_discussions_json: string | null;
        last_review_at: number | null;
        created_at: number;
        updated_at: number;
      }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      mrIid: r.mr_iid,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      state: r.state,
      title: r.title ?? undefined,
      webUrl: r.web_url ?? undefined,
      findingsJson: r.findings_json ?? undefined,
      fixBranch: r.fix_branch ?? undefined,
      riskLevel: r.risk_level ?? undefined,
      reviewerCommentsCount: r.reviewer_comments_count,
      unresolvedCommentsCount: r.unresolved_comments_count,
      ciStatus: r.ci_status ?? undefined,
      lastReviewerCommentAt: r.last_reviewer_comment_at ?? undefined,
      postedDiscussionsJson: r.posted_discussions_json ?? undefined,
      lastReviewAt: r.last_review_at ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  updateMrState(
    projectId: string,
    mrIid: number,
    patch: Partial<Omit<ReturnType<MetadataStore['getMrState']>, 'id' | 'projectId' | 'mrIid' | 'createdAt'>>
  ): void {
    const allowedFields = [
      'sourceBranch',
      'targetBranch',
      'state',
      'title',
      'webUrl',
      'findingsJson',
      'fixBranch',
      'riskLevel',
      'reviewerCommentsCount',
      'unresolvedCommentsCount',
      'ciStatus',
      'lastReviewerCommentAt',
      'postedDiscussionsJson',
      'lastReviewAt',
      'updatedAt',
    ] as const;
    const columnMap: Record<string, string> = {
      sourceBranch: 'source_branch',
      targetBranch: 'target_branch',
      state: 'state',
      title: 'title',
      webUrl: 'web_url',
      findingsJson: 'findings_json',
      fixBranch: 'fix_branch',
      riskLevel: 'risk_level',
      reviewerCommentsCount: 'reviewer_comments_count',
      unresolvedCommentsCount: 'unresolved_comments_count',
      ciStatus: 'ci_status',
      lastReviewerCommentAt: 'last_reviewer_comment_at',
      postedDiscussionsJson: 'posted_discussions_json',
      lastReviewAt: 'last_review_at',
      updatedAt: 'updated_at',
    };

    const entries = Object.entries(patch).filter(([key]) => allowedFields.includes(key as (typeof allowedFields)[number]));
    if (entries.length === 0) return;

    const setClauses = entries.map(([key]) => {
      const column = columnMap[key];
      if (!column) throw new Error(`非法 MR 状态字段: ${key}`);
      return `${column} = ?`;
    });
    const values = entries.map(([, value]) => value ?? null);

    this.db
      .prepare(`UPDATE mr_review_states SET ${setClauses.join(', ')} WHERE project_id = ? AND mr_iid = ?`)
      .run(...values, projectId, mrIid);
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
