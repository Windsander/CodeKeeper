import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { invoke } from '../api/electron-api';

/**
 * MR 评审页面
 *
 * 展示 MR 自动评审 Agent 的服务状态、已启用项目数等宏观指标，
 * 并提供启动/停止/重启服务的控制按钮。
 * 不展示具体 MR 列表或文件 diff。
 */
export function MrReview() {
  const { data: status, refresh } = useIpc<{ running: boolean; enabledProjects: number }>('classic.status');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    setError(null);
    try {
      await invoke(`classic.${action}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">MR 评审</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => runAction(status?.running ? 'stop' : 'start')}
            disabled={busy}
          >
            {busy ? '处理中...' : status?.running ? '停止服务' : '启动服务'}
          </button>
          {status?.running && (
            <button
              className="btn btn-primary"
              onClick={() => runAction('restart')}
              disabled={busy}
            >
              重启服务
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card">
        <div className="project-meta">
          服务状态:
          <span
            style={{
              marginLeft: 8,
              color: status?.running ? 'var(--success)' : 'var(--text-secondary)',
              fontWeight: 600,
            }}
          >
            {status?.running ? '运行中' : '已停止'}
          </span>
        </div>
        <div className="project-meta">已启用 MR 评审的项目数: {status?.enabledProjects ?? 0}</div>
      </div>

      <div className="card">
        <h3 className="card-title">说明</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
          MR 评审服务作为独立子进程运行，定时轮询已启用项目的 GitLab open MRs，
          自动生成评审意见并发表到 MR 中。服务启动后会读取当前 LLM 配置和项目配置。
        </p>
      </div>
    </div>
  );
}
