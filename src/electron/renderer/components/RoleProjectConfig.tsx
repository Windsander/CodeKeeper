import { useState, useEffect } from 'react';
import { invoke } from '../api/electron-api';
import { useIpc } from '../hooks/useIpc';
import { Dropdown } from '../components/Dropdown';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { AutocompleteInput } from '../components/AutocompleteInput';
import { getRoleUI, type RoleFieldConfig } from '../roles/role-registry.js';
import type { Role, RoleConfig, Project, GitlabConfig } from '../../shared/types.js';

interface ClassicStatus {
  running: boolean;
  enabledProjects: number;
  runningProjects: string[];
}

type FilterField = 'author' | 'assignee' | 'reviewer' | 'label' | 'sourceBranch' | 'targetBranch' | 'draft';

interface FilterCondition {
  field: FilterField;
  values: string[];
}

interface RoleProjectConfigProps {
  role: Role;
  project: Project;
  onSaved: () => void;
}

export const DEFAULT_GITLAB: GitlabConfig = {
  baseUrl: 'https://gitlab.com',
  projectPath: '',
  token: '',
  defaultBranch: 'main',
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

const LEARNING_OPTIONS = [
  { value: 'on', label: '开启（从人工 review 中持续优化）' },
  { value: 'off', label: '关闭' },
];

const FILTER_FIELD_OPTIONS: { value: FilterField; label: string }[] = [
  { value: 'author', label: 'Author' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'label', label: 'Label' },
  { value: 'sourceBranch', label: 'Source Branch' },
  { value: 'targetBranch', label: 'Target Branch' },
  { value: 'draft', label: 'Draft' },
];

const DRAFT_OPTIONS = [
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
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

function getAutocompleteOptions(
  field: FilterField,
  members: Array<{ username: string; name?: string }>,
  labels: string[]
): string[] {
  switch (field) {
    case 'author':
    case 'assignee':
    case 'reviewer':
      return members.map((m) => (m.name ? `${m.username} (${m.name})` : m.username));
    case 'label':
      return labels;
    default:
      return [];
  }
}

/**
 * 角色项目配置面板
 *
 * 根据角色渲染对应的配置项：Git 仓库、过滤条件、公共策略、角色专属字段、Agent 个性。
 */
export function RoleProjectConfig({ role, project, onSaved }: RoleProjectConfigProps) {
  const ui = getRoleUI(role);
  const gitlab = project.gitlab ?? DEFAULT_GITLAB;

  const { data: serviceStatus } = useIpc<ClassicStatus>('role.service.status', { role });

  const [gitlabUrl, setGitlabUrl] = useState(buildGitlabUrl(gitlab));
  const [token, setToken] = useState(gitlab.token);
  const [showToken, setShowToken] = useState(false);

  const [config, setConfig] = useState<RoleConfig>(() => ui.defaultConfig);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);

  const [members, setMembers] = useState<Array<{ username: string; name?: string }>>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [protectedBranches, setProtectedBranches] = useState<string[]>([]);
  const [allBranches, setAllBranches] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);

  const [soulContent, setSoulContent] = useState('');
  const [soulSourcePath, setSoulSourcePath] = useState('');
  const [soulLoading, setSoulLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reviewSchedule = config.reviewSchedule;
  const learningEnabled = config.learningEnabled;
  const isCustom = !REVIEW_INTERVALS.some((i) => i.cron === reviewSchedule && i.cron !== 'custom');
  const [customSchedule, setCustomSchedule] = useState(reviewSchedule);

  // 加载角色配置
  useEffect(() => {
    let cancelled = false;
    invoke<{ config: RoleConfig }>('project.role.config.get', { projectId: project.id, role })
      .then((res) => {
        if (cancelled) return;
        const loaded = res.config;
        setConfig(loaded);
        setFilterConditions(loaded.filter?.conditions ?? []);
        setCustomSchedule(loaded.reviewSchedule);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(`加载 ${role} 配置失败:`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, role]);

  // 加载 Soul 内容
  useEffect(() => {
    let cancelled = false;
    setSoulLoading(true);
    invoke('project.soul.get', { projectId: project.id })
      .then((res) => {
        if (cancelled) return;
        const soul = (res as { soul: { content: string; sourcePath: string } }).soul;
        setSoulContent(soul.content);
        setSoulSourcePath(soul.sourcePath);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('加载 SOUL.md 失败:', err);
      })
      .finally(() => {
        if (!cancelled) setSoulLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // 加载过滤提示数据
  useEffect(() => {
    let cancelled = false;
    setSuggestLoading(true);
    Promise.all([
      invoke('project.members', { projectId: project.id }),
      invoke('project.labels', { projectId: project.id }),
      invoke('project.protected-branches', { projectId: project.id }),
      invoke('project.branches', { projectId: project.id }),
    ])
      .then(([membersRes, labelsRes, protectedRes, branchesRes]) => {
        if (cancelled) return;
        setMembers((membersRes as { members: Array<{ username: string; name?: string }> }).members);
        setLabels((labelsRes as { labels: string[] }).labels);
        setProtectedBranches((protectedRes as { branches: string[] }).branches);
        setAllBranches((branchesRes as { branches: string[] }).branches);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('加载过滤提示数据失败:', err);
      })
      .finally(() => {
        if (!cancelled) setSuggestLoading(false);
      });
  }, [project.id]);

  const handleIntervalChange = (value: string) => {
    if (value === 'custom') {
      setConfig((prev) => ({ ...prev, reviewSchedule: customSchedule }));
    } else {
      setConfig((prev) => ({ ...prev, reviewSchedule: value }));
      setCustomSchedule(value);
    }
  };

  const handleCustomScheduleChange = (value: string) => {
    setCustomSchedule(value);
    setConfig((prev) => ({ ...prev, reviewSchedule: value }));
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

  const applySoulTemplate = () => {
    setSoulContent(ui.defaultSoulTemplate);
  };

  const addFilterCondition = () => {
    setFilterConditions((prev) => [...prev, { field: 'author', values: [''] }]);
  };

  const removeFilterCondition = (index: number) => {
    setFilterConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateFilterField = (index: number, field: FilterField) => {
    setFilterConditions((prev) => {
      const next = [...prev];
      next[index] = { field, values: field === 'draft' ? ['false'] : [''] };
      return next;
    });
  };

  const updateFilterValues = (index: number, raw: string) => {
    setFilterConditions((prev) => {
      const next = [...prev];
      const field = next[index].field;
      const values = raw
        .split(',')
        .map((v) => {
          const trimmed = v.trim();
          if (field === 'author' || field === 'assignee' || field === 'reviewer') {
            const match = trimmed.match(/^(.+?)\s*\(/);
            return match ? match[1] : trimmed;
          }
          return trimmed;
        })
        .filter(Boolean);
      next[index] = { ...next[index], values };
      return next;
    });
  };

  const updateDraftValue = (index: number, value: string) => {
    setFilterConditions((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], values: [value] };
      return next;
    });
  };

  const updateConfigField = <K extends keyof RoleConfig>(key: K, value: RoleConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const renderRoleField = (field: RoleFieldConfig<Role>) => {
    const value = config[field.key as keyof RoleConfig];
    const fieldId = `role-field-${role}-${String(field.key)}`;
    switch (field.type) {
      case 'text': {
        const textValue = typeof value === 'string' ? value : '';
        return (
          <div key={String(field.key)} className="form-group">
            <label htmlFor={fieldId}>{field.label}</label>
            <input
              id={fieldId}
              className="input"
              value={textValue}
              onChange={(e) => updateConfigField(field.key as keyof RoleConfig, e.target.value)}
            />
          </div>
        );
      }
      case 'toggle': {
        const toggleValue = value === true;
        return (
          <div key={String(field.key)} className="form-group">
            <label id={`${fieldId}-label`}>{field.label}</label>
            <Dropdown
              value={toggleValue ? 'on' : 'off'}
              options={[
                { value: 'on', label: '开启' },
                { value: 'off', label: '关闭' },
              ]}
              onChange={(v) => updateConfigField(field.key as keyof RoleConfig, v === 'on')}
              aria-labelledby={`${fieldId}-label`}
            />
          </div>
        );
      }
      case 'schedule': {
        const scheduleValue = typeof value === 'string' ? value : '';
        return (
          <div key={String(field.key)} className="form-group">
            <label htmlFor={fieldId}>{field.label}</label>
            <input
              id={fieldId}
              className="input"
              value={scheduleValue}
              placeholder="*/10 * * * *"
              onChange={(e) => updateConfigField(field.key as keyof RoleConfig, e.target.value)}
            />
          </div>
        );
      }
      default:
        return null;
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

      const nextConfig: RoleConfig = {
        ...config,
        reviewSchedule: reviewSchedule.trim(),
        learningEnabled,
        filter: { conditions: filterConditions },
      };

      await invoke('project.role.config.update', {
        projectId: project.id,
        role,
        config: nextConfig,
      });

      await invoke('project.soul.update', {
        projectId: project.id,
        content: soulContent,
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
  const displaySoulFileName = ui.soulFileName;

  return (
    <div className="card" style={{ marginTop: 16, background: 'var(--main-bg)' }}>
      {error && <div className="error-message" style={{ marginBottom: 16 }}>{error}</div>}
      {saved && serviceStatus?.running && (
        <div className="project-meta" style={{ marginBottom: 16, color: 'var(--success)' }}>
          配置已保存，对应项目的 Agent 将自动重启以应用新配置。
        </div>
      )}

      <CollapsibleSection title="Git 仓库">
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
          <div className="input-group">
            <input
              type={showToken ? 'text' : 'password'}
              className="input"
              value={token}
              placeholder="请输入 GitLab Access Token"
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              type="button"
              className="input-group-btn"
              onClick={() => setShowToken((prev) => !prev)}
              aria-label={showToken ? '隐藏 Access Token' : '显示 Access Token'}
              title={showToken ? '隐藏' : '显示'}
            >
              {showToken ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          <div className="project-meta" style={{ marginTop: 6 }}>
            需要 api、read_repository、write_repository 权限以读取 MR 并发表评论
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="过滤条件">
        {filterConditions.length === 0 && (
          <div className="project-meta" style={{ marginBottom: 12 }}>
            未设置过滤条件，将处理所有开放 MR
          </div>
        )}
        {filterConditions.map((condition, index) => (
          <div
            key={index}
            className="form-row filter-condition-row"
            style={{ marginBottom: 8, alignItems: 'center' }}
          >
            <Dropdown
              value={condition.field}
              options={FILTER_FIELD_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(value) => updateFilterField(index, value as FilterField)}
              className="filter-field-dropdown"
            />
            {condition.field === 'draft' ? (
              <Dropdown
                value={condition.values[0] ?? 'false'}
                options={DRAFT_OPTIONS}
                onChange={(value) => updateDraftValue(index, value)}
              />
            ) : condition.field === 'sourceBranch' || condition.field === 'targetBranch' ? (
              <AutocompleteInput
                value={condition.values[0] ?? ''}
                options={condition.field === 'sourceBranch' ? allBranches : protectedBranches}
                placeholder={condition.field === 'sourceBranch' ? '输入源分支名称' : '输入目标分支名称'}
                loading={suggestLoading}
                onChange={(value) => updateFilterValues(index, value)}
              />
            ) : (
              <AutocompleteInput
                value={condition.values.join(', ')}
                options={getAutocompleteOptions(condition.field, members, labels)}
                placeholder={
                  condition.field === 'label'
                    ? '输入标签，多个用英文逗号分隔'
                    : '输入用户名，多个用英文逗号分隔'
                }
                loading={suggestLoading}
                onChange={(value) => updateFilterValues(index, value)}
              />
            )}
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => removeFilterCondition(index)}
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={addFilterCondition}
        >
          + 添加条件
        </button>
      </CollapsibleSection>

      <CollapsibleSection title="Agent 策略">
        <div className="form-group">
          <label>启用状态</label>
          <Dropdown
            value={config.enabled ? 'on' : 'off'}
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '禁用' },
            ]}
            onChange={(value) => updateConfigField('enabled', value === 'on')}
          />
        </div>

        <div className="form-group">
          <label>自动学习模式</label>
          <Dropdown
            value={learningEnabled ? 'on' : 'off'}
            options={LEARNING_OPTIONS}
            onChange={(value) => updateConfigField('learningEnabled', value === 'on')}
          />
          <div className="project-meta" style={{ marginTop: 6 }}>
            开启后，Agent 会从人工 review、resolve/comment 行为中学习并优化后续策略。
          </div>
        </div>

        <div className="form-group">
          <label>调度间隔</label>
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

        {ui.projectConfigFields.map(renderRoleField)}
      </CollapsibleSection>

      <CollapsibleSection title={`Agent 个性配置（${displaySoulFileName}）`}>
        <div className="form-group">
          <div className="form-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <label style={{ marginBottom: 0 }}>SOUL.md 内容</label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={applySoulTemplate}
              disabled={soulLoading}
            >
              使用默认模板
            </button>
          </div>
          <textarea
            className="input"
            style={{ minHeight: 240, fontFamily: 'monospace', lineHeight: 1.5, resize: 'vertical' }}
            value={soulContent}
            placeholder="# Agent 个性配置&#10;## 风格&#10;..."
            onChange={(e) => setSoulContent(e.target.value)}
          />
          <div className="project-meta" style={{ marginTop: 6 }}>
            保存位置: {soulSourcePath}
          </div>
        </div>
      </CollapsibleSection>

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
