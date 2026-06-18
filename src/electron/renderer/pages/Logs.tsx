import { useEffect, useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { LogViewer } from '../components/LogViewer';

export function Logs() {
  const [lines, setLines] = useState(100);
  const { data, loading, refresh } = useIpc<{ lines: string[] }>('daemon.logs', { lines });

  // 每 2 秒自动刷新一次日志
  useEffect(() => {
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">日志</h1>
        <button className="btn btn-primary" onClick={() => refresh()}>刷新</button>
      </div>

      <div className="card">
        <div className="form-row" style={{ maxWidth: 240 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
            显示行数:
            <input
              type="number"
              className="input"
              value={lines}
              onChange={(e) => setLines(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      {loading && !data ? <div className="loading">加载中...</div> : <LogViewer lines={data?.lines || []} />}
    </div>
  );
}
