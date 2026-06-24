-- 项目注册表
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  archive_root TEXT,
  name TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_scanned_at INTEGER,
  gitlab_config TEXT,
  roles_config TEXT NOT NULL DEFAULT '{}'
);

-- 文件系统事件队列
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('add', 'change', 'unlink')),
  timestamp INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

-- 知识条目元数据
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'archived', 'ignored', 'orphaned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project ON watch_events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_processed ON watch_events(processed);
CREATE INDEX IF NOT EXISTS idx_entries_project ON knowledge_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_status ON knowledge_entries(status);

-- 项目自定义分类 schema
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  UNIQUE(project_id, name)
);

-- 归档建议/动作记录
CREATE TABLE IF NOT EXISTS archive_actions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('copy', 'organize', 'ignore', 'flag')),
  reason TEXT NOT NULL,
  source_path TEXT,
  archive_path TEXT,
  target_path TEXT,
  related_entry_id TEXT,
  risk TEXT NOT NULL CHECK(risk IN ('low', 'medium', 'high')),
  confidence REAL NOT NULL,
  executed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  executed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_actions_project ON archive_actions(project_id);
CREATE INDEX IF NOT EXISTS idx_actions_executed ON archive_actions(executed);

-- 归档动作执行历史，支持撤销
CREATE TABLE IF NOT EXISTS action_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('copy', 'organize', 'ignore', 'flag')),
  source_path TEXT NOT NULL,
  archive_path TEXT,
  target_path TEXT,
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied', 'undone')),
  applied_at INTEGER NOT NULL,
  undone_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_history_project ON action_history(project_id);
CREATE INDEX IF NOT EXISTS idx_history_action ON action_history(action_id);
CREATE INDEX IF NOT EXISTS idx_history_status ON action_history(status);

-- 归档文件元数据（图书管理员模式）
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
  type TEXT NOT NULL DEFAULT 'copy',
  copied_at INTEGER NOT NULL,
  organized_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'orphaned', 'superseded')),
  FOREIGN KEY (entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metadata_project ON archive_metadata(project_id);
CREATE INDEX IF NOT EXISTS idx_metadata_category ON archive_metadata(category);
CREATE INDEX IF NOT EXISTS idx_metadata_doc_type ON archive_metadata(doc_type);
CREATE INDEX IF NOT EXISTS idx_metadata_status ON archive_metadata(status);

-- MR 自动评审状态
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
  posted_discussions_json TEXT,
  last_review_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, mr_iid)
);

CREATE INDEX IF NOT EXISTS idx_mr_state_project ON mr_review_states(project_id);
CREATE INDEX IF NOT EXISTS idx_mr_state_state ON mr_review_states(state);
