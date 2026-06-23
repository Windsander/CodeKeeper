import { useState } from 'react';
import { useIpc } from '../hooks/useIpc';
import { invoke } from '../api/electron-api';
import { Toggle } from '../components/Toggle';
import {
  MrReviewProjectConfig,
  type ProjectWithMrConfig,
  DEFAULT_MR_REVIEW,
} from '../components/MrReviewProjectConfig';

interface ClassicStatus {
  running: boolean;
  enabledProjects: number;
  runningProjects: string[];
}

interface MrAgentProjectStatus {
  lastError?: {
    type: 'missing-token' | 'invalid-token' | 'gitlab-api' | 'unknown';
    message: string;
    at: number;
  };
  lastSuccessAt?: number;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function getStatusBadges(
  project: ProjectWithMrConfig,
  runningProjects: string[],
  agentStatus?: MrAgentProjectStatus | null,
  serviceRunning?: boolean
) {
  const badges: Array<{ label: string; className: string; title?: string }> = [];
  const hasGitlab = Boolean(project.gitlab?.baseUrl && project.gitlab?.projectPath);
  const enabled = project.mrReview?.enabled ?? false;

  if (!hasGitlab) {
    badges.push({ label: 'GitLab 未配置', className: 'badge badge-warning' });
  } else if (!project.gitlab?.token) {
    badges.push({ label: 'Token 缺失', className: 'badge badge-danger' });
  }

  if (!enabled) {
    badges.push({ label: 'MR 评审未启用', className: 'badge badge-info' });
    return badges;
  }

  if (!serviceRunning) {
    badges.push({
      label: '服务未启动',
      className: 'badge badge-secondary',
      title: '点击上方"启动服务"后，该项目的 MR Agent 才会开始运行',
    });
    return badges;
  }

  if (runningProjects.includes(project.id)) {
    badges.push({ label: 'Agent 运行中', className: 'badge badge-success' });
  }

  if (agentStatus?.lastError) {
    const error = agentStatus.lastError;
    switch (error.type) {
      case 'missing-token':
        badges.push({
          label: 'Token 缺失',
          className: 'badge badge-danger',
          title: error.message,
        });
        break;
      case 'invalid-token':
        badges.push({
          label: 'Token 过期',
          className: 'badge badge-danger',
          title: error.message,
        });
        break;
      case 'gitlab-api':
        badges.push({
          label: 'GitLab API 错误',
          className: 'badge badge-warning',
          title: error.message,
        });
        break;
      default:
        badges.push({
          label: 'Agent 异常',
          className: 'badge badge-warning',
          title: error.message,
        });
    }
  } else if (agentStatus?.lastSuccessAt) {
    badges.push({
      label: `上次评审于 ${formatRelativeTime(agentStatus.lastSuccessAt)}`,
      className: 'badge badge-info',
    });
  }

  return badges;
}

interface ProjectCardProps {
  project: ProjectWithMrConfig;
  runningProjects: string[];
  serviceRunning: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onSaved: () => void;
}

function ProjectCard({
  project,
  runningProjects,
  serviceRunning,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onSaved,
}: ProjectCardProps) {
  const { data: agentStatus } = useIpc<MrAgentProjectStatus>(
    'project.mrreview.status.get',
    { projectId: project.id },
    { pollInterval: 5000 }
  );

  const badges = getStatusBadges(project, runningProjects, agentStatus, serviceRunning);

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{project.name}</div>
          <div className="project-meta">{project.rootPath}</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {badges.map((badge, idx) => (
              <span
                key={idx}
                className={badge.className}
                title={badge.title}
                style={{ cursor: badge.title ? 'help' : undefined }}
              >
                {badge.label}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Toggle checked={project.mrReview?.enabled ?? false} onChange={onToggleEnabled}>
            {(project.mrReview?.enabled ?? false) ? '已启用' : '未启用'}
          </Toggle>
          <button className="btn btn-primary btn-sm" onClick={onToggleExpand}>
            {expanded ? '收起' : '配置'}
          </button>
        </div>
      </div>
      {expanded && (
        <MrReviewProjectConfig
          project={project}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

/**
 * MR 评审页面
 *
 * 展示 MR 自动评审 Agent 的服务状态、已启用项目数等宏观指标，
 * 并提供启动/停止/重启服务的控制按钮。
 * 同时列出所有已注册项目，允许为每个项目配置 GitLab 与 MR 评审参数。
 */
export function MrReview() {
  const { data: status, refresh: refreshStatus } = useIpc<ClassicStatus>('classic.status', undefined, { pollInterval: 5000 });
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

  const runningProjects = status?.runningProjects ?? [];

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
            {status?.running
              ? `运行中（${runningProjects.length} / ${status?.enabledProjects ?? 0} 个项目）`
              : '已停止'}
          </span>
        </div>
        <div className="project-meta">已启用 MR 评审的项目数: {status?.enabledProjects ?? 0}</div>
      </div>

      <div className="card">
        <h3 className="card-title">项目配置</h3>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: 14,
            lineHeight: 1.6,
            marginBottom: 16,
          }}
        >
          为项目配置 GitLab 仓库信息并启用 MR 评审后，该项目将加入全局服务的轮询范围。
          点击上方"启动服务"才会为所有已启用的项目启动 MR Agent；服务运行中单独勾选/取消项目可实时启动或停止该项目的 Agent。
        </p>

        {!projects || projects.length === 0 ? (
          <div className="empty-state">暂无注册项目，请先前往仪表盘注册项目。</div>
        ) : (
          <div>
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                runningProjects={runningProjects}
                serviceRunning={status?.running ?? false}
                expanded={expandedId === project.id}
                onToggleExpand={() => toggleConfig(project.id)}
                onToggleEnabled={() => toggleMrReview(project)}
                onSaved={() => {
                  refreshProjects();
                  refreshStatus();
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">说明</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
          MR 评审服务为每个启用项目启动独立的 Agent 子进程，各项目按自身的 cron 调度轮询 GitLab open MRs。
          某个项目的 Token 问题只会影响该项目的 Agent，其他项目继续正常运行。
        </p>
      </div>
    </div>
  );
}
