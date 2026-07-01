import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { PageLayout } from '../components/PageLayout';
import { HistoryIcon, UndoIcon } from '../components/icons';
import type { ArchiveAction } from '../../shared/types';

interface HistoryItem extends ArchiveAction {
  historyId: number;
  projectId: string;
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

  if (loading) return <div className="loading">加载中...</div>;
  if (error) return <div className="error-message">错误: {error}</div>;

  const items = data || [];

  return (
    <PageLayout icon={<HistoryIcon />} title="动作历史" onRefresh={() => refresh()}>
      <div className="card">
        <div className="form-row" style={{ maxWidth: 480 }}>
          <input
            className="input"
            placeholder="项目 ID（留空查询全部）"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <h3>暂无动作历史</h3>
          <p>归档执行后，这里会显示已应用的归档动作。</p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>类型</th>
                <th>源路径</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.historyId}>
                  <td>{item.id}</td>
                  <td>{item.type}</td>
                  <td>{item.sourcePath}</td>
                  <td>
                    <span className={`badge ${item.status === 'applied' ? 'badge-success' : 'badge-info'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td>
                    {item.status === 'applied' && (
                      <button
                        className="action-undo-btn"
                        onClick={() => handleUndo(item.id, item.projectId)}
                        title="撤销"
                        aria-label="撤销"
                      >
                        <UndoIcon />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageLayout>
  );
}
