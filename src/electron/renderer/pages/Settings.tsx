import { useState, useEffect } from 'react';
import { useIpc } from '../hooks/useIpc';

interface DaemonConfig {
  apiKeyConfigured: boolean;
  scanCron: string;
}

export function Settings() {
  const { data, loading, refresh } = useIpc<DaemonConfig>('daemon.config');
  const [apiKey, setApiKey] = useState('');
  const [scanCron, setScanCron] = useState('*/5 * * * *');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setScanCron(data.scanCron);
    }
  }, [data]);

  const save = async () => {
    setSaved(false);
    await window.electronAPI.invoke('daemon.config.update', { apiKey: apiKey || undefined, scanCron });
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

      <div className="card" style={{ maxWidth: 560 }}>
        <div className="form-group">
          <label>API Key</label>
          <input
            type="password"
            className="input"
            value={apiKey}
            placeholder={data?.apiKeyConfigured ? '已配置（留空保持不变）' : '请输入 Anthropic API Key'}
            onChange={(e) => setApiKey(e.target.value)}
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
