import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { invoke } from '../api/electron-api';
import { Toggle } from '../components/Toggle';
import {
  MrReviewProjectConfig,
  type ProjectWithMrConfig,
  DEFAULT_MR_REVIEW,
} from '../components/MrReviewProjectConfig';

/**
 * MR 评审页面
 *
 * 展示 MR 自动评审 Agent 的服务状态、已启用项目数等宏观指标，
 * 并提供启动/停止/重启服务的控制按钮。
 * 同时列出所有已注册项目，允许为每个项目配置 GitLab 与 MR 评审参数。
 */
export function MrReview() {
  const { data: status, refresh: refreshStatus } = useIpc<{ running: boolean; enabledProjects: number }>('classic.status');
  const { data: projects, refresh: refreshProjects } = useIpc<ProjectWithMrConfig[]>('project.list');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    setError(null);
    try {
      await invoke(`classic.${action}`);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleConfig = (projectId: string) => {
    setExpandedId((prev) => (prev === projectId ? null : projectId));
  };

  const toggleMrReview = async (project: ProjectWithMrConfig) => {
    const nextEnabled = !project.mrReview?.enabled;
    const gitlab = project.gitlab;
    const missingConfig =
      nextEnabled &&
      (!gitlab?.baseUrl || !gitlab?.projectPath || !gitlab?.token);
    if (missingConfig) {
      setExpandedId(project.id);
      return;
    }
    try {
      await invoke('project.mrreview.config.update', {
        projectId: project.id,
        mrReview: {
          ...(project.mrReview ?? DEFAULT_MR_REVIEW),
          enabled: nextEnabled,
        },
      });
      await refreshProjects();
      await refreshStatus();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
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
        <h3 className="card-title">项目配置</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
          为项目配置 GitLab 仓库信息与 MR 评审开关后，MR 评审服务才会轮询该项目的 open MRs。
        </p>

        {!projects || projects.length === 0 ? (
          <div className="empty-state">暂无注册项目，请先前往仪表盘注册项目。</div>
        ) : (
          <div>
            {projects.map((project) => {
              const hasGitlab = Boolean(project.gitlab?.baseUrl && project.gitlab?.projectPath);
              const enabled = project.mrReview?.enabled ?? false;
              return (
                <div key={project.id} className="card" style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{project.name}</div>
                      <div className="project-meta">{project.rootPath}</div>
                      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                        {enabled ? (
                          <span className="badge badge-success">已启用</span>
                        ) : (
                          <span className="badge">未启用</span>
                        )}
                        {hasGitlab ? (
                          <span className="badge badge-success">GitLab 已配置</span>
                        ) : (
                          <span className="badge badge-warning">GitLab 未配置</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Toggle
                        checked={enabled}
                        onChange={() => toggleMrReview(project)}
                      >
                        {enabled ? '已启用' : '未启用'}
                      </Toggle>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => toggleConfig(project.id)}
                      >
                        {expandedId === project.id ? '收起' : '配置'}
                      </button>
                    </div>
                  </div>
                  {expandedId === project.id && (
                    <MrReviewProjectConfig
                      project={project}
                      onSaved={() => {
                        refreshProjects();
                        refreshStatus();
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
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
