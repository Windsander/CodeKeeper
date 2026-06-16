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

export function Settings() {
  const { data, loading, refresh } = useIpc<DaemonConfig>('daemon.config');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [headers, setHeaders] = useState('');
  const [scanCron, setScanCron] = useState('*/5 * * * *');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setScanCron(data.scanCron);
      setApiUrl(data.apiUrl ?? '');
      setProvider(data.provider ?? 'anthropic');
      setModel(data.model ?? '');
      setHeaders(data.headers ?? '');
    }
  }, [data]);

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
    if (headers.trim()) payload.headers = headers.trim();

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
          <label>自定义 Headers（JSON，可选）</label>
          <textarea
            className="input"
            rows={4}
            value={headers}
            placeholder='{"X-Model-Request-Id": "1234"}'
            onChange={(e) => setHeaders(e.target.value)}
          />
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
