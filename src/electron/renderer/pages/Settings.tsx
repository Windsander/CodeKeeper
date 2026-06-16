import { useState, useEffect } from 'react';
import { useIpc } from '../hooks/useIpc';

interface DaemonConfig {
  apiKeyConfigured: boolean;
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

export function Settings() {
  const { data, loading, refresh } = useIpc<DaemonConfig>('daemon.config');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>([{ key: '', value: '' }]);
  const [scanCron, setScanCron] = useState('*/5 * * * *');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setScanCron(data.scanCron);
      setApiUrl(data.apiUrl ?? '');
      setProvider(data.provider ?? 'anthropic');
      setModel(data.model ?? '');
      const entries = parseHeaders(data.headers ?? '');
      setHeaderEntries(entries.length > 0 ? entries : [{ key: '', value: '' }]);
    }
  }, [data]);

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
      apiKey?: string;
      apiUrl?: string;
      provider?: string;
      model?: string;
      headers?: string;
      scanCron: string;
    } = { scanCron };

    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    if (apiUrl.trim()) payload.apiUrl = apiUrl.trim();
    if (provider.trim()) payload.provider = provider.trim();
    if (model.trim()) payload.model = model.trim();

    const headers = stringifyHeaders(headerEntries);
    if (headers !== '{}') payload.headers = headers;

    await window.electronAPI.invoke('daemon.config.update', payload);
    setSaved(true);
    setApiKey('');
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
          <input
            type="password"
            className="input"
            value={apiKey}
            placeholder={data?.apiKeyConfigured ? '已配置（留空保持不变）' : '请输入 API Key'}
            onChange={(e) => setApiKey(e.target.value)}
          />
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
          <label>扫描间隔 (cron)</label>
          <input
            className="input"
            value={scanCron}
            placeholder="*/5 * * * *"
            onChange={(e) => setScanCron(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-primary" onClick={save}>保存</button>
          {saved && <span className="badge badge-success">已保存</span>}
        </div>
      </div>
    </div>
  );
}
