import { useState } from 'react';
import { invoke } from '../api/electron-api';

interface GitlabConfig {
  baseUrl: string;
  projectPath: string;
  token: string;
  defaultBranch: string;
}

interface MrReviewConfig {
  enabled: boolean;
  autoMergeMode: 'full' | 'audit';
  reviewSchedule: string;
  learningEnabled: boolean;
  maxAutoMergeRisk: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface ProjectWithMrConfig {
  id: string;
  name: string;
  rootPath: string;
  gitlab?: GitlabConfig | null;
  mrReview?: MrReviewConfig | null;
}

interface MrReviewProjectConfigProps {
  project: ProjectWithMrConfig;
  onSaved: () => void;
}

const DEFAULT_GITLAB: GitlabConfig = {
  baseUrl: 'https://gitlab.com',
  projectPath: '',
  token: '',
  defaultBranch: 'main',
};

const DEFAULT_MR_REVIEW: MrReviewConfig = {
  enabled: false,
  autoMergeMode: 'audit',
  reviewSchedule: '*/10 * * * *',
  learningEnabled: false,
  maxAutoMergeRisk: 'MEDIUM',
};

/**
 * MR 评审项目级配置面板
 *
 * 允许为单个项目配置 GitLab 仓库信息与 MR 评审行为。
 */
export function MrReviewProjectConfig({ project, onSaved }: MrReviewProjectConfigProps) {
  const gitlab = project.gitlab ?? DEFAULT_GITLAB;
  const mrReview = project.mrReview ?? DEFAULT_MR_REVIEW;

  const [baseUrl, setBaseUrl] = useState(gitlab.baseUrl);
  const [projectPath, setProjectPath] = useState(gitlab.projectPath);
  const [token, setToken] = useState(gitlab.token);
  const [defaultBranch, setDefaultBranch] = useState(gitlab.defaultBranch);
  const [enabled, setEnabled] = useState(mrReview.enabled);
  const [autoMergeMode, setAutoMergeMode] = useState(mrReview.autoMergeMode);
  const [reviewSchedule, setReviewSchedule] = useState(mrReview.reviewSchedule);
  const [learningEnabled, setLearningEnabled] = useState(mrReview.learningEnabled);
  const [maxAutoMergeRisk, setMaxAutoMergeRisk] = useState(mrReview.maxAutoMergeRisk);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await invoke('project.gitlab.config.update', {
        projectId: project.id,
        gitlab: {
          baseUrl: baseUrl.trim(),
          projectPath: projectPath.trim(),
          token: token.trim(),
          defaultBranch: defaultBranch.trim() || 'main',
        },
      });
      await invoke('project.mrreview.config.update', {
        projectId: project.id,
        mrReview: {
          enabled,
          autoMergeMode,
          reviewSchedule: reviewSchedule.trim(),
          learningEnabled,
          maxAutoMergeRisk,
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isGitlabValid = baseUrl.trim() && projectPath.trim();

  return (
    <div className="card" style={{ marginTop: 16, background: 'var(--main-bg)' }}>
      <h4 className="card-title" style={{ marginBottom: 16 }}>
        配置项目：{project.name}
      </h4>

      {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="form-group">
        <label className="form-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>启用 MR 自动评审</span>
        </label>
      </div>

      <div className="form-group">
        <label>GitLab 地址</label>
        <input
          className="input"
          value={baseUrl}
          placeholder="https://gitlab.com"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>项目路径（group/project）</label>
        <input
          className="input"
          value={projectPath}
          placeholder="my-group/my-project"
          onChange={(e) => setProjectPath(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>Access Token</label>
        <input
          type="password"
          className="input"
          value={token}
          placeholder="请输入 GitLab Access Token"
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="project-meta" style={{ marginTop: 6 }}>
          需要 api、read_repository、write_repository 权限以读取 MR 并发表评论
        </div>
      </div>

      <div className="form-group">
        <label>默认分支</label>
        <input
          className="input"
          value={defaultBranch}
          placeholder="main"
          onChange={(e) => setDefaultBranch(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>自动合并模式</label>
        <select
          className="input"
          value={autoMergeMode}
          onChange={(e) => setAutoMergeMode(e.target.value as 'full' | 'audit')}
        >
          <option value="audit">仅审计（只评论不合并）</option>
          <option value="full">全自动（低风险投资可合并）</option>
        </select>
      </div>

      <div className="form-group">
        <label>评审调度 Cron</label>
        <input
          className="input"
          value={reviewSchedule}
          placeholder="*/10 * * * *"
          onChange={(e) => setReviewSchedule(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>允许自动合并的最大风险</label>
        <select
          className="input"
          value={maxAutoMergeRisk}
          onChange={(e) => setMaxAutoMergeRisk(e.target.value as 'LOW' | 'MEDIUM' | 'HIGH')}
        >
          <option value="LOW">LOW</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="HIGH">HIGH</option>
        </select>
      </div>

      <div className="form-group">
        <label className="form-checkbox">
          <input
            type="checkbox"
            checked={learningEnabled}
            onChange={(e) => setLearningEnabled(e.target.checked)}
          />
          <span>启用学习模式（从人工 review 中持续优化）</span>
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={saving || !isGitlabValid}
        >
          {saving ? '保存中...' : '保存'}
        </button>
        {saved && <span className="badge badge-success">已保存</span>}
      </div>
    </div>
  );
}
