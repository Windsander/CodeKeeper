import { useEffect, useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { LogViewer } from '../components/LogViewer';
import { LocalModelLogViewer } from '../components/LocalModelLogViewer';

type LogTab = 'all' | 'reviewer' | 'maintainer';

const TABS: Array<{ key: LogTab; label: string }> = [
  { key: 'all', label: '全部日志' },
  { key: 'reviewer', label: '自动评审' },
  { key: 'maintainer', label: '自动维护' },
];

const LEVEL_LABELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/**
 * 从原始 JSON 文本中提取某个字符串字段的第一次出现值
 * 用于兼容历史日志中重复 key 导致 JSON.parse 丢失内容的情况
 */
function extractFirstStringField(raw: string, field: string): string | null {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = raw.match(pattern);
  if (!match) return null;
  return match[1]
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

/**
 * 将单条 pino JSON 日志格式化为易读文本
 * - 时间戳转本地时间
 * - level 转 INFO/WARN/ERROR 等标签
 * - 提取 role 与 output/msg 字段
 * - 将 \\n 转回真正的换行
 */
function formatLogLine(line: string): string {
  const text = line.trim();
  if (!text.startsWith('{')) {
    return text.replace(/\\n/g, '\n');
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const time =
      typeof parsed.time === 'number'
        ? new Date(parsed.time).toLocaleString('zh-CN')
        : '';
    const levelLabel =
      typeof parsed.level === 'number'
        ? LEVEL_LABELS[parsed.level] ?? String(parsed.level)
        : '';
    const role = typeof parsed.role === 'string' ? `[${parsed.role}]` : '';

    let message = '';
    if (typeof parsed.output === 'string') {
      message = parsed.output;
    } else if (typeof parsed.msg === 'string') {
      // 历史日志中 msg 被占位符覆盖时，尝试从原始文本提取第一次出现的 msg 值
      if (parsed.msg === '[Role Agent]' || parsed.msg === '[Scan Worker]') {
        message = extractFirstStringField(text, 'msg') ?? parsed.msg;
      } else {
        message = parsed.msg;
      }
    }
    message = message.replace(/\\n/g, '\n');

    const parts = [`[${time}]`, levelLabel, role, message].filter(Boolean);
    return parts.join(' ');
  } catch {
    return text.replace(/\\n/g, '\n');
  }
}

export function Logs() {
  const [tab, setTab] = useState<LogTab>('all');
  const [lines, setLines] = useState(100);

  const method = tab === 'all' ? 'daemon.logs' : 'role.service.logs';
  const params = tab === 'all' ? { lines } : { role: tab, lines };
  const { data, loading, refresh } = useIpc<{ lines: string[] }>(method, params);

  // 每 2 秒自动刷新一次日志
  useEffect(() => {
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const formattedLines = (data?.lines || []).map(formatLogLine);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">日志</h1>
        <button className="btn btn-primary" onClick={() => refresh()}>刷新</button>
      </div>

      <div className="logs-page-layout">
        <div className="card logs-card logs-card--main">
          <div className="logs-card-header">
            <div className="logs-tabs">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className={`logs-tab-btn${tab === t.key ? ' active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="logs-lines-control">
              <label htmlFor="logs-lines">显示行数</label>
              <input
                id="logs-lines"
                type="number"
                className="input"
                value={lines}
                onChange={(e) => setLines(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="logs-card-body">
            {loading && !data ? (
              <div className="loading">加载中...</div>
            ) : (
              <LogViewer lines={formattedLines} />
            )}
          </div>
        </div>

        <div className="card logs-card logs-card--local">
          <div className="logs-card-header">
            <h3 className="logs-card-title">本地模型日志</h3>
          </div>
          <div className="logs-card-body">
            <LocalModelLogViewer />
          </div>
        </div>
      </div>
    </div>
  );
}
