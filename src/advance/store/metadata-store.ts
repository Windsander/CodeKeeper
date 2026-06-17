import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Project, WatchedEvent, KnowledgeEntry, GitlabConfig, MrReviewConfig, MrReviewState } from '../types';

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

  // ---------- 辅助方法：JSON 序列化与反序列化 ----------

  /** 将对象序列化为 JSON 字符串，undefined 返回 null */
  private stringifyJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
  }

  /** 将 JSON 字符串解析为对象，null/undefined 返回 undefined */
  private parseJson<T>(value: string | null | undefined): T | undefined {
    if (value === null || value === undefined) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  /** 从数据库行构造 Project 对象，处理 JSON 字段 */
  private rowToProject(r: {
    id: string;
    root_path: string;
    name: string;
    registered_at: number;
    last_scanned_at: number | null;
    gitlab_config: string | null;
    mr_review_config: string | null;
  }): Project {
    return {
      id: r.id,
      rootPath: r.root_path,
      name: r.name,
      registeredAt: r.registered_at,
      lastScannedAt: r.last_scanned_at,
      gitlab: this.parseJson<GitlabConfig>(r.gitlab_config),
      mrReview: this.parseJson<MrReviewConfig>(r.mr_review_config),
    };
  }

  // ---------- 项目 ----------

  registerProject(project: Project): void {
    const stmt = this.db.prepare(
      `INSERT INTO projects (id, root_path, name, registered_at, last_scanned_at, gitlab_config, mr_review_config)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         last_scanned_at = excluded.last_scanned_at,
         gitlab_config = excluded.gitlab_config,
         mr_review_config = excluded.mr_review_config`
    );
    stmt.run(
      project.id,
      project.rootPath,
      project.name,
      project.registeredAt,
      project.lastScannedAt,
      this.stringifyJson(project.gitlab),
      this.stringifyJson(project.mrReview)
    );
  }

  unregisterProject(projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    this.db.prepare('DELETE FROM watch_events WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_entries WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM mr_review_states WHERE project_id = ?').run(projectId);
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY registered_at DESC').all() as Array<{
      id: string;
      root_path: string;
      name: string;
      registered_at: number;
      last_scanned_at: number | null;
      gitlab_config: string | null;
      mr_review_config: string | null;
    }>;
    return rows.map((r) => this.rowToProject(r));
  }

  getProject(projectId: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | {
          id: string;
          root_path: string;
          name: string;
          registered_at: number;
          last_scanned_at: number | null;
          gitlab_config: string | null;
          mr_review_config: string | null;
        }
      | undefined;
    return r ? this.rowToProject(r) : null;
  }

  updateLastScannedAt(projectId: string, timestamp: number): void {
    this.db.prepare('UPDATE projects SET last_scanned_at = ? WHERE id = ?').run(timestamp, projectId);
  }

  /** 更新项目的 GitLab 配置 */
  updateProjectGitlabConfig(projectId: string, config: GitlabConfig): void {
    this.db.prepare('UPDATE projects SET gitlab_config = ? WHERE id = ?').run(JSON.stringify(config), projectId);
  }

  /** 更新项目的 MR 评审配置 */
  updateMrReviewConfig(projectId: string, config: MrReviewConfig): void {
    this.db.prepare('UPDATE projects SET mr_review_config = ? WHERE id = ?').run(JSON.stringify(config), projectId);
  }

  /** 获取启用了 MR 评审且配置了 GitLab 的项目列表 */
  getMrEnabledProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM projects
         WHERE gitlab_config IS NOT NULL
           AND mr_review_config IS NOT NULL
         ORDER BY registered_at DESC`
      )
      .all() as Array<{
      id: string;
      root_path: string;
      name: string;
      registered_at: number;
      last_scanned_at: number | null;
      gitlab_config: string | null;
      mr_review_config: string | null;
    }>;
    return rows
      .map((r) => this.rowToProject(r))
      .filter((p) => p.gitlab !== undefined && p.mrReview !== undefined && p.mrReview.enabled);
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

  // ---------- MR 评审状态 ----------

  /** 从数据库行构造 MrReviewState 对象 */
  private rowToMrState(r: {
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
    created_at: number;
    updated_at: number;
  }): MrReviewState {
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
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** 插入或更新 MR 评审状态 */
  insertOrUpdateMrState(state: MrReviewState): void {
    const stmt = this.db.prepare(
      `INSERT INTO mr_review_states (
        id, project_id, mr_iid, source_branch, target_branch, state,
        title, web_url, findings_json, fix_branch, risk_level,
        reviewer_comments_count, unresolved_comments_count, ci_status,
        last_reviewer_comment_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, mr_iid) DO UPDATE SET
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
      state.createdAt,
      state.updatedAt
    );
  }

  /** 根据项目 ID 和 MR IID 查询单个 MR 状态 */
  getMrState(projectId: string, mrIid: number): MrReviewState | undefined {
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
          created_at: number;
          updated_at: number;
        }
      | undefined;
    return r ? this.rowToMrState(r) : undefined;
  }

  /** 列出指定项目的所有 MR 状态 */
  listMrStatesByProject(projectId: string): MrReviewState[] {
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
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => this.rowToMrState(r));
  }

  /** 列出指定状态的所有 MR 状态 */
  listMrStatesByState(state: string): MrReviewState[] {
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
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => this.rowToMrState(r));
  }

  /** 部分更新 MR 状态 */
  updateMrState(projectId: string, mrIid: number, patch: Partial<MrReviewState>): void {
    const allowedFields = [
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
    ] as const;

    const entries = Object.entries(patch).filter(([key]) =>
      allowedFields.includes(key as (typeof allowedFields)[number])
    );

    if (entries.length === 0) return;

    // 将 camelCase 字段名映射为 snake_case 列名
    const columnMap: Record<string, string> = {
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
    };

    const setClauses = entries.map(([key]) => `${columnMap[key]} = ?`).join(', ');
    const values = entries.map(([, value]) => {
      if (value === undefined) return null;
      return value;
    });

    const sql = `UPDATE mr_review_states SET ${setClauses}, updated_at = ? WHERE project_id = ? AND mr_iid = ?`;
    this.db.prepare(sql).run(...values, Date.now(), projectId, mrIid);
  }
}
