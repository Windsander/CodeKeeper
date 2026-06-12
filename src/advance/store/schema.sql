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
