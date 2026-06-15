-- 项目注册表
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_scanned_at INTEGER
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
  type TEXT NOT NULL CHECK(type IN ('move', 'merge', 'create', 'ignore', 'flag')),
  reason TEXT NOT NULL,
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
  type TEXT NOT NULL CHECK(type IN ('move', 'merge', 'create', 'ignore', 'flag')),
  source_path TEXT NOT NULL,
  target_path TEXT,
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN ('applied', 'undone')),
  applied_at INTEGER NOT NULL,
  undone_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_history_project ON action_history(project_id);
CREATE INDEX IF NOT EXISTS idx_history_action ON action_history(action_id);
CREATE INDEX IF NOT EXISTS idx_history_status ON action_history(status);
