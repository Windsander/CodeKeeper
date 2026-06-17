export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  archiveRoot?: string;
  healthScore: number;
  pending: number;
  archived: number;
  ignored: number;
  orphaned: number;
  copied: number;
  organized: number;
  flagged: number;
  lastScannedAt: number | null;
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
  const healthPercent = Math.round(project.healthScore * 100);
  let badgeClass = 'badge badge-success';
  if (healthPercent < 60) badgeClass = 'badge badge-danger';
  else if (healthPercent < 80) badgeClass = 'badge badge-warning';

  return (
    <div>
      <h3>{project.name}</h3>
      <div className="project-path">{project.rootPath}</div>
      {project.archiveRoot && (
        <div className="project-meta">归档位置: {project.archiveRoot}</div>
      )}
      <div className="project-stats">
        <div className="project-stat">
          <div className="project-stat-label">健康度</div>
          <div className="project-stat-value"><span className={badgeClass}>{healthPercent}%</span></div>
        </div>
        <div className="project-stat">
          <div className="project-stat-label">已复制</div>
          <div className="project-stat-value">{project.copied}</div>
        </div>
        <div className="project-stat">
          <div className="project-stat-label">已整理</div>
          <div className="project-stat-value">{project.organized}</div>
        </div>
        <div className="project-stat">
          <div className="project-stat-label">标记</div>
          <div className="project-stat-value">{project.flagged}</div>
        </div>
      </div>
      <div className="project-meta">
        待处理: {project.pending} · 已归档: {project.archived} · 已忽略: {project.ignored} · 已孤儿: {project.orphaned} · 最后扫描: {project.lastScannedAt ? new Date(project.lastScannedAt).toLocaleString() : '从未'}
      </div>
    </div>
  );
}
