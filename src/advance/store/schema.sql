-- 项目注册表
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_scanned_at INTEGER,
  gitlab_config TEXT,
  mr_review_config TEXT
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'archived', 'ignored')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- MR 评审状态
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

CREATE INDEX IF NOT EXISTS idx_events_project ON watch_events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_processed ON watch_events(processed);
CREATE INDEX IF NOT EXISTS idx_entries_project ON knowledge_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_status ON knowledge_entries(status);
CREATE INDEX IF NOT EXISTS idx_mr_state_project ON mr_review_states(project_id);
CREATE INDEX IF NOT EXISTS idx_mr_state_state ON mr_review_states(state);
