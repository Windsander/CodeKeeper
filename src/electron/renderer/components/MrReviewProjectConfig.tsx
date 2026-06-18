import { useState } from 'react';
import { invoke } from '../api/electron-api';
import { Dropdown } from '../components/Dropdown';

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

export const DEFAULT_GITLAB: GitlabConfig = {
  baseUrl: 'https://gitlab.com',
  projectPath: '',
  token: '',
  defaultBranch: 'main',
};

export const DEFAULT_MR_REVIEW: MrReviewConfig = {
  enabled: false,
  autoMergeMode: 'audit',
  reviewSchedule: '*/10 * * * *',
  learningEnabled: true,
  maxAutoMergeRisk: 'MEDIUM',
};

const REVIEW_INTERVALS = [
  { label: '每 1 分钟', cron: '*/1 * * * *' },
  { label: '每 5 分钟', cron: '*/5 * * * *' },
  { label: '每 10 分钟', cron: '*/10 * * * *' },
  { label: '每 15 分钟', cron: '*/15 * * * *' },
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每天', cron: '0 9 * * *' },
  { label: '自定义', cron: 'custom' },
];

const AUTO_MERGE_OPTIONS = [
  { value: 'audit', label: '仅审计（只评论不合并）' },
  { value: 'full', label: '全自动（低风险投资可合并）' },
];

const LEARNING_OPTIONS = [
  { value: 'on', label: '开启（从人工 review 中持续优化）' },
  { value: 'off', label: '关闭' },
];

const RISK_OPTIONS = [
  { value: 'LOW', label: 'LOW' },
  { value: 'MEDIUM', label: 'MEDIUM' },
  { value: 'HIGH', label: 'HIGH' },
];

function buildGitlabUrl(gitlab?: GitlabConfig | null): string {
  if (!gitlab || !gitlab.baseUrl) return '';
  const base = gitlab.baseUrl.replace(/\/$/, '');
  const path = (gitlab.projectPath || '').replace(/^\//, '');
  return path ? `${base}/${path}` : base;
}

function parseGitlabUrl(url: string): { baseUrl: string; projectPath: string } | null {
  try {
    const u = new URL(url.trim());
    const baseUrl = `${u.protocol}//${u.host}`;
    const projectPath = u.pathname.replace(/^\/|\.git$/g, '').replace(/^\//, '');
    if (!projectPath) return null;
    return { baseUrl, projectPath };
  } catch {
    return null;
  }
}

/**
 * MR 评审项目级配置面板
 *
 * 允许为单个项目配置 GitLab 仓库信息与 MR 评审行为。
 */
export function MrReviewProjectConfig({ project, onSaved }: MrReviewProjectConfigProps) {
  const gitlab = project.gitlab ?? DEFAULT_GITLAB;
  const mrReview = project.mrReview ?? DEFAULT_MR_REVIEW;

  const [gitlabUrl, setGitlabUrl] = useState(buildGitlabUrl(gitlab));
  const [token, setToken] = useState(gitlab.token);
  const [autoMergeMode, setAutoMergeMode] = useState(mrReview.autoMergeMode);
  const [reviewSchedule, setReviewSchedule] = useState(mrReview.reviewSchedule);
  const [customSchedule, setCustomSchedule] = useState(mrReview.reviewSchedule);
  const [learningEnabled, setLearningEnabled] = useState(mrReview.learningEnabled);
  const [maxAutoMergeRisk, setMaxAutoMergeRisk] = useState(mrReview.maxAutoMergeRisk);

  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isCustom = !REVIEW_INTERVALS.some((i) => i.cron === reviewSchedule && i.cron !== 'custom');

  const handleIntervalChange = (value: string) => {
    if (value === 'custom') {
      setReviewSchedule(customSchedule);
    } else {
      setReviewSchedule(value);
      setCustomSchedule(value);
    }
  };

  const handleCustomScheduleChange = (value: string) => {
    setCustomSchedule(value);
    setReviewSchedule(value);
  };

  const detectGit = async () => {
    setDetecting(true);
    setError(null);
    try {
      const info = (await invoke('project.git.detect', { projectId: project.id })) as {
        baseUrl?: string;
        projectPath?: string;
        defaultBranch?: string;
        branches?: string[];
      };
      if (info.baseUrl && info.projectPath) {
        setGitlabUrl(`${info.baseUrl.replace(/\/$/, '')}/${info.projectPath.replace(/^\//, '')}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const parsed = parseGitlabUrl(gitlabUrl);
      if (!parsed) {
        throw new Error('GitLab 项目 URL 格式不正确，示例：https://gitlab.com/group/project');
      }
      await invoke('project.gitlab.config.update', {
        projectId: project.id,
        gitlab: {
          baseUrl: parsed.baseUrl,
          projectPath: parsed.projectPath,
          token: token.trim(),
          defaultBranch: 'main',
        },
      });
      await invoke('project.mrreview.config.update', {
        projectId: project.id,
        mrReview: {
          enabled: project.mrReview?.enabled ?? DEFAULT_MR_REVIEW.enabled,
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

  const isGitlabValid = Boolean(parseGitlabUrl(gitlabUrl));

  return (
    <div className="card" style={{ marginTop: 16, background: 'var(--main-bg)' }}>
      {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="config-section">
        <h5 className="config-section-title">Git 仓库</h5>
        <div className="form-group">
          <label>GitLab 项目 URL</label>
          <div className="form-row">
            <input
              className="input"
              value={gitlabUrl}
              placeholder="https://gitlab.com/group/project"
              onChange={(e) => setGitlabUrl(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={detectGit}
              disabled={detecting}
            >
              {detecting ? '检测中...' : '自动检测'}
            </button>
          </div>
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
      </div>

      <div className="config-section">
        <h5 className="config-section-title">MR 评审行为</h5>
        <div className="form-group">
          <label>自动合并模式</label>
          <Dropdown
            value={autoMergeMode}
            options={AUTO_MERGE_OPTIONS}
            onChange={(value) => setAutoMergeMode(value as 'full' | 'audit')}
          />
        </div>

        <div className="form-group">
          <label>自动学习模式</label>
          <Dropdown
            value={learningEnabled ? 'on' : 'off'}
            options={LEARNING_OPTIONS}
            onChange={(value) => setLearningEnabled(value === 'on')}
          />
        </div>

        <div className="form-group">
          <label>允许自动合并的最大风险</label>
          <Dropdown
            value={maxAutoMergeRisk}
            options={RISK_OPTIONS}
            onChange={(value) => setMaxAutoMergeRisk(value as 'LOW' | 'MEDIUM' | 'HIGH')}
          />
        </div>

        <div className="form-group">
          <label>评审调度间隔</label>
          <Dropdown
            value={isCustom ? 'custom' : reviewSchedule}
            options={REVIEW_INTERVALS.map((i) => ({ value: i.cron, label: i.label }))}
            onChange={(value) => handleIntervalChange(value)}
          />
          {isCustom && (
            <input
              className="input"
              style={{ marginTop: 8 }}
              value={customSchedule}
              placeholder="*/10 * * * *"
              onChange={(e) => handleCustomScheduleChange(e.target.value)}
            />
          )}
          <div className="project-meta" style={{ marginTop: 6 }}>
            当前 cron: {reviewSchedule}
          </div>
        </div>
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
