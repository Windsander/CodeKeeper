import { Link } from 'react-router-dom';

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  healthScore: number;
  pending: number;
  archived: number;
  ignored: number;
  suggestion: number;
  lastScannedAt: number | null;
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <h3><Link to={`/project/${project.id}`}>{project.name}</Link></h3>
      <p style={{ color: '#666', fontSize: 12 }}>{project.rootPath}</p>
      <div>健康度: {Math.round(project.healthScore * 100)}%</div>
      <div>待处理: {project.pending} | 已归档: {project.archived} | 已忽略: {project.ignored}</div>
      <div>建议: {project.suggestion}</div>
      <div>最后扫描: {project.lastScannedAt ? new Date(project.lastScannedAt).toLocaleString() : '从未'}</div>
    </div>
  );
}
