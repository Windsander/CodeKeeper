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

  if (loading) return <div>加载中...</div>;
  if (error) return <div style={{ color: 'red' }}>错误: {error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>仪表盘</h1>
        <button onClick={refresh}>刷新</button>
      </div>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
        <h3>注册新项目</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="项目根目录绝对路径，例如 D:\\WorkingSpace\\my-project"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
          />
          <button onClick={register}>注册</button>
        </div>
        {registerError && <div style={{ color: 'red', marginTop: 8 }}>{registerError}</div>}
      </div>

      {(!projects || projects.length === 0) ? (
        <div>暂无注册项目</div>
      ) : (
        projects.map((p) => (
          <div key={p.id} style={{ position: 'relative' }}>
            <ProjectCard project={p} />
            <button
              style={{ position: 'absolute', top: 16, right: 16 }}
              onClick={() => unregister(p.id)}
            >
              注销
            </button>
          </div>
        ))
      )}
    </div>
  );
}
