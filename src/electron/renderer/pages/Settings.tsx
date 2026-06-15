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

  useEffect(() => {
    if (data) {
      setScanCron(data.scanCron);
    }
  }, [data]);

  const save = async () => {
    await window.electronAPI.invoke('daemon.config.update', { apiKey: apiKey || undefined, scanCron });
    refresh();
  };

  if (loading) return <div>加载中...</div>;

  return (
    <div>
      <h1>设置</h1>
      <div>
        <label>API Key: </label>
        <input
          type="password"
          value={apiKey}
          placeholder={data?.apiKeyConfigured ? '已配置（留空保持不变）' : '请输入'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div>
        <label>扫描间隔 (cron): </label>
        <input value={scanCron} onChange={(e) => setScanCron(e.target.value)} />
      </div>
      <button onClick={save}>保存</button>
    </div>
  );
}
