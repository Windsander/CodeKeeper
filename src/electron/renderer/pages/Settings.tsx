import { useState, useEffect } from 'react';
import { useIpc } from '../hooks/useIpc';

interface DaemonConfig {
  apiKey: string;
  apiUrl: string;
  provider: string;
  model: string;
  headers: string;
  scanCron: string;
}

interface HeaderEntry {
  key: string;
  value: string;
}

function parseHeaders(json: string): HeaderEntry[] {
  if (!json.trim()) return [];
  try {
    const obj = JSON.parse(json) as Record<string, string>;
    return Object.entries(obj).map(([key, value]) => ({ key, value }));
  } catch {
    return [];
  }
}

function stringifyHeaders(entries: HeaderEntry[]): string {
  const obj: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.key.trim()) {
      obj[entry.key.trim()] = entry.value;
    }
  }
  return JSON.stringify(obj);
}

const SCAN_INTERVALS = [
  { label: '每 1 分钟', cron: '*/1 * * * *' },
  { label: '每 5 分钟', cron: '*/5 * * * *' },
  { label: '每 15 分钟', cron: '*/15 * * * *' },
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每天', cron: '0 9 * * *' },
  { label: '自定义', cron: 'custom' },
];

export function Settings() {
  const { data, loading, refresh } = useIpc<DaemonConfig>('daemon.config');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>([{ key: '', value: '' }]);
  const [scanCron, setScanCron] = useState('*/5 * * * *');
  const [customCron, setCustomCron] = useState('*/5 * * * *');
  const [saved, setSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    if (data) {
      setScanCron(data.scanCron);
      setCustomCron(data.scanCron);
      setApiKey(data.apiKey ?? '');
      setApiUrl(data.apiUrl ?? '');
      setProvider(data.provider ?? 'anthropic');
      setModel(data.model ?? '');
      const entries = parseHeaders(data.headers ?? '');
      setHeaderEntries(entries.length > 0 ? entries : [{ key: '', value: '' }]);
    }
  }, [data]);

  const handleIntervalChange = (value: string) => {
    if (value === 'custom') {
      setScanCron(customCron);
    } else {
      setScanCron(value);
      setCustomCron(value);
    }
  };

  const handleCustomCronChange = (value: string) => {
    setCustomCron(value);
    setScanCron(value);
  };

  const isCustom = !SCAN_INTERVALS.some((i) => i.cron === scanCron && i.cron !== 'custom');

  const updateHeader = (index: number, field: keyof HeaderEntry, value: string) => {
    setHeaderEntries((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addHeader = () => {
    setHeaderEntries((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeHeader = (index: number) => {
    setHeaderEntries((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ key: '', value: '' }];
    });
  };

  const save = async () => {
    setSaved(false);
    const payload: {
      apiKey: string;
      apiUrl?: string;
      provider?: string;
      model?: string;
      headers?: string;
      scanCron: string;
    } = { apiKey: apiKey.trim(), scanCron };

    if (apiUrl.trim()) payload.apiUrl = apiUrl.trim();
    if (provider.trim()) payload.provider = provider.trim();
    if (model.trim()) payload.model = model.trim();

    const headers = stringifyHeaders(headerEntries);
    if (headers !== '{}') payload.headers = headers;

    await window.electronAPI.invoke('daemon.config.update', payload);
    setSaved(true);
    refresh();
  };

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">设置</h1>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="form-group">
          <label>Provider</label>
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI 兼容</option>
          </select>
        </div>

        <div className="form-group">
          <label>API Key</label>
          <div className="input-group">
            <input
              type={showApiKey ? 'text' : 'password'}
              className="input"
              value={apiKey}
              placeholder="请输入 API Key"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              type="button"
              className="input-group-btn"
              onClick={() => setShowApiKey((prev) => !prev)}
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              title={showApiKey ? '隐藏' : '显示'}
            >
              {showApiKey ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div className="form-group">
          <label>API Base URL（可选）</label>
          <input
            className="input"
            value={apiUrl}
            placeholder="https://api.anthropic.com（留空使用默认）"
            onChange={(e) => setApiUrl(e.target.value)}
          />
          <div className="project-meta" style={{ marginTop: 6 }}>
            OpenAI 兼容示例：https://your-openai-proxy.example.com/v1/chat/completions
          </div>
        </div>

        <div className="form-group">
          <label>Model</label>
          <input
            className="input"
            value={model}
            placeholder={provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-20241022'}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>自定义 Headers</label>
          {headerEntries.map((entry, index) => (
            <div key={index} className="form-row" style={{ marginBottom: 8 }}>
              <input
                className="input"
                placeholder="Header 名称，如 X-Model-Request-Id"
                value={entry.key}
                onChange={(e) => updateHeader(index, 'key', e.target.value)}
              />
              <input
                className="input"
                placeholder="Header 值，如 1234"
                value={entry.value}
                onChange={(e) => updateHeader(index, 'value', e.target.value)}
              />
              <button className="btn btn-danger btn-sm" onClick={() => removeHeader(index)}>删除</button>
            </div>
          ))}
          <button className="btn btn-primary btn-sm" onClick={addHeader}>+ 添加 Header</button>
        </div>

        <div className="form-group">
          <label>扫描间隔</label>
          <select
            className="input"
            value={isCustom ? 'custom' : scanCron}
            onChange={(e) => handleIntervalChange(e.target.value)}
          >
            {SCAN_INTERVALS.map((item) => (
              <option key={item.cron} value={item.cron}>
                {item.label}
              </option>
            ))}
          </select>
          {isCustom && (
            <input
              className="input"
              style={{ marginTop: 8 }}
              value={customCron}
              placeholder="*/5 * * * *"
              onChange={(e) => handleCustomCronChange(e.target.value)}
            />
          )}
          <div className="project-meta" style={{ marginTop: 6 }}>
            当前 cron: {scanCron}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-primary" onClick={save}>保存</button>
          {saved && <span className="badge badge-success">已保存</span>}
        </div>
      </div>
    </div>
  );
}
