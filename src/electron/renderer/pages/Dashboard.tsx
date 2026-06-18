import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke, showOpenDialog } from '../api/electron-api';
import { ProjectCard, type ProjectSummary } from '../components/ProjectCard';

export function Dashboard() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [archiveRoot, setArchiveRoot] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const lastDataRef = useRef<string>('');

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await invoke<ProjectSummary[]>('project.list');
      const serialized = JSON.stringify(data);
      if (serialized !== lastDataRef.current) {
        lastDataRef.current = serialized;
        setProjects(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      refresh(true);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const pickRootPath = async () => {
    const result = await showOpenDialog({
      title: '选择要监控的项目目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      setRootPath(result.filePaths[0]);
    }
  };

  const pickArchiveRoot = async () => {
    const result = await showOpenDialog({
      title: '选择归档位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      setArchiveRoot(result.filePaths[0]);
    }
  };

  const register = async () => {
    if (!rootPath.trim() || registering) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      await window.electronAPI.invoke('project.register', {
        rootPath: rootPath.trim(),
        archiveRoot: archiveRoot.trim() || undefined,
      });
      setRootPath('');
      setArchiveRoot('');
      await refresh();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegistering(false);
    }
  };

  const unregister = async (projectId: string) => {
    try {
      await window.electronAPI.invoke('project.unregister', { projectId });
      await refresh();
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
        <button className="btn btn-primary" onClick={() => refresh()}>刷新</button>
      </div>

      <div className="card">
        <h3 className="card-title">注册新项目</h3>

        <div className="form-group">
          <label>项目路径（被监控的源码目录）</label>
          <div className="form-row">
            <input
              className="input"
              placeholder="点击右侧按钮选择项目目录"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
            />
            <button className="btn btn-primary" onClick={pickRootPath}>选择...</button>
          </div>
        </div>

        <div className="form-group">
          <label>归档位置（存放整理后的文档，留空则使用项目内 .codekeeper）</label>
          <div className="form-row">
            <input
              className="input"
              placeholder="点击右侧按钮选择归档目录"
              value={archiveRoot}
              onChange={(e) => setArchiveRoot(e.target.value)}
            />
            <button className="btn btn-primary" onClick={pickArchiveRoot}>选择...</button>
          </div>
        </div>

        <button
          className="btn btn-primary"
          onClick={register}
          disabled={registering || !rootPath.trim()}
        >
          {registering ? '注册中...' : '注册'}
        </button>
        {registerError && <div className="error-message">{registerError}</div>}
      </div>

      {(!projects || projects.length === 0) ? (
        <div className="empty-state">
          <h3>暂无注册项目</h3>
          <p>在上方选择项目路径和归档位置，即可开始监控。</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <div
              key={p.id}
              className="project-card"
              onClick={() => navigate(`/project/${p.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  navigate(`/project/${p.id}`);
                }
              }}
            >
              <ProjectCard project={p} />
              <div className="project-actions">
                <button
                  className="btn btn-danger btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    unregister(p.id);
                  }}
                >
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
