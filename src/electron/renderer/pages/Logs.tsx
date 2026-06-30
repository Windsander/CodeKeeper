import { useEffect, useMemo, useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useModelLogs } from '../hooks/useModelLogs';
import { LogViewer } from '../components/LogViewer';

type LogTab = 'all' | 'reviewer' | 'maintainer' | 'localModel';

const TABS: Array<{ key: LogTab; label: string }> = [
  { key: 'all', label: '全部日志' },
  { key: 'reviewer', label: '自动评审' },
  { key: 'maintainer', label: '自动维护' },
  { key: 'localModel', label: '本地模型' },
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
 * 本地模型日志关键词过滤器。
 * 只保留与模型准备、下载、加载、运行、错误相关的行，过滤掉高频访问日志等噪声。
 */
const MODEL_LOG_KEYWORDS = [
  'infinity_emb',
  'Uvicorn',
  'Started server',
  'Application startup complete',
  'Creating',
  'engine',
  'selected',
  'model',
  'warmup',
  'Downloading',
  'embeddings/sec',
  'ready to batch',
  'Infinity',
  'ERROR',
  'error',
  '失败',
  '超时',
  '进程退出',
  '退出',
  'CUDA',
  'out of memory',
  'Traceback',
  'Loading pretrained',
  'sentence_transformers',
  'torch',
  'bettertransformer',
];

function filterModelLogLine(line: string): boolean {
  const lower = line.toLowerCase();
  return MODEL_LOG_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
}

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
  const isLocalModelTab = tab === 'localModel';

  const method = tab === 'all' ? 'daemon.logs' : 'role.service.logs';
  const params = tab === 'all' ? { lines } : { role: tab, lines };
  const { data, loading: daemonLoading, error: daemonError, refresh: refreshDaemon } = useIpc<{ lines: string[] }>(
    isLocalModelTab ? 'daemon.logs' : method,
    isLocalModelTab ? { lines } : params
  );

  const {
    embedding,
    rerank,
    loading: modelLoading,
    error: modelError,
    refresh: refreshModel,
  } = useModelLogs(lines);

  // 每 2 秒自动刷新一次日志
  useEffect(() => {
    const id = setInterval(() => {
      if (!isLocalModelTab) {
        refreshDaemon();
      }
      refreshModel();
    }, 2000);
    return () => clearInterval(id);
  }, [isLocalModelTab, refreshDaemon, refreshModel]);

  const formattedLines = useMemo(() => {
    if (isLocalModelTab) {
      const tagged = [
        ...embedding.map((line) => `[embedding] ${line}`),
        ...rerank.map((line) => `[rerank] ${line}`),
      ];
      return tagged.filter(filterModelLogLine);
    }
    return (data?.lines || []).map(formatLogLine);
  }, [isLocalModelTab, data, embedding, rerank]);

  const loading = isLocalModelTab ? modelLoading : daemonLoading;
  const error = isLocalModelTab ? modelError : daemonError;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">日志</h1>
        <button className="btn btn-primary" onClick={() => { if (!isLocalModelTab) refreshDaemon(); refreshModel(); }}>刷新</button>
      </div>

      <div className="card logs-card">
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
          {loading && formattedLines.length === 0 ? (
            <div className="loading">加载中...</div>
          ) : error ? (
            <div className="loading">读取失败: {error}</div>
          ) : (
            <LogViewer lines={formattedLines} />
          )}
        </div>
      </div>
    </div>
  );
}
