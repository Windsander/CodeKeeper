import { useIpc } from '../hooks/useIpc';
import { ProjectCard, type ProjectSummary } from '../components/ProjectCard';

export function Dashboard() {
  const { data: projects, loading, error, refresh } = useIpc<ProjectSummary[]>('project.list');

  if (loading) return <div>加载中...</div>;
  if (error) return <div style={{ color: 'red' }}>错误: {error}</div>;
  if (!projects || projects.length === 0) return <div>暂无注册项目</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>仪表盘</h1>
        <button onClick={refresh}>刷新</button>
      </div>
      {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
    </div>
  );
}
