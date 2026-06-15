import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { LogViewer } from '../components/LogViewer';

export function Logs() {
  const [lines, setLines] = useState(100);
  const { data, loading, refresh } = useIpc<{ lines: string[] }>('daemon.logs', { lines });

  return (
    <div>
      <h1>日志</h1>
      <div>
        <label>行数: </label>
        <input type="number" value={lines} onChange={(e) => setLines(Number(e.target.value))} />
        <button onClick={refresh}>刷新</button>
      </div>
      {loading ? <div>加载中...</div> : <LogViewer lines={data?.lines || []} />}
    </div>
  );
}
