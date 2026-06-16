import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { ProjectCard, type ProjectSummary } from '../components/ProjectCard';

export function Dashboard() {
  const { data: projects, loading, error, refresh } = useIpc<ProjectSummary[]>('project.list');
  const [rootPath, setRootPath] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);

  const register = async () => {
    if (!rootPath.trim()) return;
    setRegisterError(null);
    try {
      await window.electronAPI.invoke('project.register', { rootPath: rootPath.trim() });
      setRootPath('');
      refresh();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    }
  };

  const unregister = async (projectId: string) => {
    try {
      await window.electronAPI.invoke('project.unregister', { projectId });
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return <div className="loading">加载中...</div>;
  if (error) return <div className="error-message">错误: {error}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">仪表盘</h1>
        <button className="btn btn-primary" onClick={refresh}>刷新</button>
      </div>

      <div className="card">
        <h3 className="card-title">注册新项目</h3>
        <div className="form-row">
          <input
            className="input"
            placeholder="项目根目录绝对路径，例如 D:\\WorkingSpace\\my-project"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
          />
          <button className="btn btn-primary" onClick={register}>注册</button>
        </div>
        {registerError && <div className="error-message">{registerError}</div>}
      </div>

      {(!projects || projects.length === 0) ? (
        <div className="empty-state">
          <h3>暂无注册项目</h3>
          <p>在上方输入项目路径并注册，即可开始监控。</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <div key={p.id} className="project-card">
              <ProjectCard project={p} />
              <div className="project-actions">
                <button className="btn btn-danger btn-sm" onClick={() => unregister(p.id)}>
                  注销
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
