import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import type { ArchiveAction } from '../../../advance/types';

interface HistoryItem extends ArchiveAction {
  historyId: number;
  status: 'applied' | 'undone';
}

export function ActionHistory() {
  const [projectId, setProjectId] = useState('');
  const { data, loading, error, refresh } = useIpc<HistoryItem[]>('action.history', {
    projectId: projectId || 'all',
  });

  const handleUndo = async (actionId: string, pid: string) => {
    await window.electronAPI.invoke('action.undo', { actionId, projectId: pid });
    refresh();
  };

  if (loading) return <div>加载中...</div>;
  if (error) return <div style={{ color: 'red' }}>错误: {error}</div>;

  return (
    <div>
      <h1>动作历史</h1>
      <input
        placeholder="项目 ID（留空查询全部）"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      />
      <button onClick={refresh}>刷新</button>
      <table style={{ width: '100%', marginTop: 16 }}>
        <thead>
          <tr><th>ID</th><th>类型</th><th>源路径</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          {(data || []).map((item) => (
            <tr key={item.historyId}>
              <td>{item.id}</td>
              <td>{item.type}</td>
              <td>{item.sourcePath}</td>
              <td>{item.status}</td>
              <td>
                {item.status === 'applied' && (
                  <button onClick={() => handleUndo(item.id, item.projectId)}>撤销</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
