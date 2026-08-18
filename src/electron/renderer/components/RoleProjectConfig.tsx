import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '../api/electron-api';
import { Dropdown } from '../components/Dropdown';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { AutocompleteInput } from '../components/AutocompleteInput';
import { getRoleUI, type RoleFieldConfig } from '../roles/role-registry.js';
import type {
  ReviewerConfig,
  Project,
  GitlabConfig,
  MaintainerConfig,
} from '../../shared/types.js';

type GitlabRole = 'reviewer' | 'maintainer';
type GitlabRoleConfig = ReviewerConfig | MaintainerConfig;

type FilterField =
  | 'author'
  | 'assignee'
  | 'reviewer'
  | 'label'
  | 'sourceBranch'
  | 'targetBranch'
  | 'draft';

interface FilterCondition {
  field: FilterField;
  values: string[];
}

interface RoleProjectConfigProps {
  role: GitlabRole;
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

const RISK_LEVEL_OPTIONS = [
  { value: 'LOW', label: '低' },
  { value: 'MEDIUM', label: '中' },
  { value: 'HIGH', label: '高' },
  { value: 'CRITICAL', label: '致命' },
] as const;

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
      return members.map(m => (m.name ? `${m.username} (${m.name})` : m.username));
    case 'label':
      return labels;
    default:
      return [];
  }
}

function configsEqualIgnoringFilter(a: GitlabRoleConfig, b: GitlabRoleConfig): boolean {
  const { filter: _a, ...restA } = a;
  const { filter: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/**
 * 角色项目配置面板
 *
 * 根据角色渲染对应的配置项：Git 仓库、过滤条件、公共策略、角色专属字段、Agent 个性。
 */
export function RoleProjectConfig({ role, project, onSaved }: RoleProjectConfigProps) {
  const ui = getRoleUI(role);
  const gitlab = project.gitlab ?? DEFAULT_GITLAB;

  const [gitlabUrl, setGitlabUrl] = useState(buildGitlabUrl(gitlab));
  const [token, setToken] = useState(gitlab.token);
  const [showToken, setShowToken] = useState(false);

  // 当 project.gitlab 从外部更新时（如首次打开 App 后项目数据才加载完成），同步输入框状态
  useEffect(() => {
    const updatedGitlab = project.gitlab ?? DEFAULT_GITLAB;
    setGitlabUrl(buildGitlabUrl(updatedGitlab));
    setToken(updatedGitlab.token);
  }, [project.gitlab?.baseUrl, project.gitlab?.projectPath, project.gitlab?.token]);

  const [config, setConfig] = useState<GitlabRoleConfig>(() => ui.defaultConfig);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);

  const [members, setMembers] = useState<Array<{ username: string; name?: string }>>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [protectedBranches, setProtectedBranches] = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);

  const [soulContent, setSoulContent] = useState('');
  const [soulSourcePath, setSoulSourcePath] = useState('');
  const [soulLoading, setSoulLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tokenError, setTokenError] = useState(false);

  const reviewSchedule = config.reviewSchedule;
  const learningEnabled = config.learningEnabled;
  const isCustom = !REVIEW_INTERVALS.some(i => i.cron === reviewSchedule && i.cron !== 'custom');
  const [customSchedule, setCustomSchedule] = useState(reviewSchedule);

  const parsedGitlab = parseGitlabUrl(gitlabUrl);
  const isGitlabValid = Boolean(parsedGitlab);
  // 基于已保存的配置判断 Git 仓库是否已配置（URL 和 token 都非空）
  const isGitlabConfigured = Boolean(
    project.gitlab?.baseUrl && project.gitlab?.projectPath && project.gitlab?.token
  );
  const isFilterConfigured = filterConditions.length > 0;
  // 当前输入框中的 GitLab 配置是否与已保存的一致
  const currentGitlabConfig = parsedGitlab
    ? { baseUrl: parsedGitlab.baseUrl, projectPath: parsedGitlab.projectPath, token: token.trim() }
    : null;
  const savedGitlabConfig = project.gitlab
    ? {
        baseUrl: project.gitlab.baseUrl.replace(/\/$/, ''),
        projectPath: project.gitlab.projectPath.replace(/^\//, '').replace(/\.git$/, ''),
        token: project.gitlab.token,
      }
    : null;
  const isGitlabDirty = JSON.stringify(currentGitlabConfig) !== JSON.stringify(savedGitlabConfig);
  // GitLab 已保存且当前输入未修改，其他组才可使用
  const isGitlabReady = isGitlabConfigured && !isGitlabDirty;

  // 各组展开状态（受控）：已配 Git 则默认折叠，未配则 Git 仓库展开
  const [gitExpanded, setGitExpanded] = useState(!isGitlabReady);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [soulExpanded, setSoulExpanded] = useState(false);

  const isAgentDefault = configsEqualIgnoringFilter(config, ui.defaultConfig);
  const soulConfigStatus =
    soulContent.trim().length === 0
      ? 'none'
      : soulContent.trim() === ui.defaultSoulTemplate.trim()
        ? 'partial'
        : 'full';

  // 加载角色配置（缺失字段用默认值补齐，方便新增配置项时向后兼容）
  useEffect(() => {
    let cancelled = false;
    invoke<{ config: GitlabRoleConfig }>('project.role.config.get', { projectId: project.id, role })
      .then(res => {
        if (cancelled) return;
        const loaded = res.config;
        const merged = { ...ui.defaultConfig, ...loaded };
        setConfig(merged);
        setFilterConditions(loaded.filter?.conditions ?? []);
        setCustomSchedule(loaded.reviewSchedule);
      })
      .catch(err => {
        if (cancelled) return;
        console.error(`加载 ${role} 配置失败:`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, role, ui.defaultConfig]);

  // 加载 Soul 内容
  useEffect(() => {
    let cancelled = false;
    setSoulLoading(true);
    invoke('project.soul.get', { projectId: project.id })
      .then(res => {
        if (cancelled) return;
        const soul = (res as { soul: { content: string; sourcePath: string } }).soul;
        setSoulContent(soul.content);
        setSoulSourcePath(soul.sourcePath);
      })
      .catch(err => {
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

  // 打开配置面板时校验 GitLab Token：若过期/无效则展开 Git 仓库组并红色闪烁提示
  useEffect(() => {
    if (!isGitlabConfigured || !project.gitlab) return;
    let cancelled = false;
    invoke('project.gitlab.verify', {
      projectId: project.id,
      gitlab: project.gitlab,
    }).catch(err => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      if (/\b(401|403)\b/.test(message)) {
        setGitExpanded(true);
        setTokenError(true);
        setTimeout(() => setTokenError(false), 2000);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  // 当已保存的 Git 配置被修改（isGitlabReady 从 true 变 false）时，自动展开 Git 仓库组
  const prevGitlabReadyRef = useRef(isGitlabReady);
  useEffect(() => {
    if (prevGitlabReadyRef.current && !isGitlabReady) {
      setGitExpanded(true);
    }
    prevGitlabReadyRef.current = isGitlabReady;
  }, [isGitlabReady]);

  // 加载过滤提示数据
  const loadSuggestions = useCallback(async () => {
    setSuggestLoading(true);
    try {
      const [membersRes, labelsRes, protectedBranchesRes, branchesRes] = await Promise.all([
        invoke('project.members', { projectId: project.id }),
        invoke('project.labels', { projectId: project.id }),
        invoke('project.protected-branches', { projectId: project.id }),
        invoke('project.branches', { projectId: project.id }),
      ]);
      setMembers((membersRes as { members: Array<{ username: string; name?: string }> }).members);
      setLabels((labelsRes as { labels: string[] }).labels);
      setProtectedBranches((protectedBranchesRes as { branches: string[] }).branches);
      setBranches((branchesRes as { branches: string[] }).branches);
    } catch (err) {
      console.error('加载过滤提示数据失败:', err);
    } finally {
      setSuggestLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (!isGitlabReady) return;
    loadSuggestions();
  }, [isGitlabReady, loadSuggestions]);

  const handleIntervalChange = (value: string) => {
    if (value === 'custom') {
      setConfig(prev => ({ ...prev, reviewSchedule: customSchedule }));
    } else {
      setConfig(prev => ({ ...prev, reviewSchedule: value }));
      setCustomSchedule(value);
    }
  };

  const handleCustomScheduleChange = (value: string) => {
    setCustomSchedule(value);
    setConfig(prev => ({ ...prev, reviewSchedule: value }));
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
    setFilterConditions(prev => [...prev, { field: 'author', values: [''] }]);
  };

  const removeFilterCondition = (index: number) => {
    setFilterConditions(prev => prev.filter((_, i) => i !== index));
  };

  const updateFilterField = (index: number, field: FilterField) => {
    setFilterConditions(prev => {
      const next = [...prev];
      next[index] = { field, values: field === 'draft' ? ['false'] : [''] };
      return next;
    });
  };

  const updateFilterValues = (index: number, raw: string) => {
    setFilterConditions(prev => {
      const next = [...prev];
      const field = next[index].field;
      const values = raw
        .split(',')
        .map(v => {
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
    setFilterConditions(prev => {
      const next = [...prev];
      next[index] = { ...next[index], values: [value] };
      return next;
    });
  };

  const updateConfigField = <K extends keyof GitlabRoleConfig>(
    key: K,
    value: GitlabRoleConfig[K]
  ) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const renderRoleField = (field: RoleFieldConfig<GitlabRole>) => {
    const value = config[field.key as keyof GitlabRoleConfig];
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
              onChange={e => updateConfigField(field.key as keyof GitlabRoleConfig, e.target.value)}
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
              onChange={v => updateConfigField(field.key as keyof GitlabRoleConfig, v === 'on')}
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
              onChange={e => updateConfigField(field.key as keyof GitlabRoleConfig, e.target.value)}
            />
          </div>
        );
      }
      case 'risk-levels': {
        const levels = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div key={String(field.key)} className="form-group">
            <label>{field.label}</label>
            <div className="form-row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
              {RISK_LEVEL_OPTIONS.map(opt => (
                <label key={opt.value} className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={levels.includes(opt.value)}
                    onChange={() => {
                      const next = levels.includes(opt.value)
                        ? levels.filter(v => v !== opt.value)
                        : [...levels, opt.value];
                      updateConfigField(
                        field.key as keyof GitlabRoleConfig,
                        next as unknown as GitlabRoleConfig[keyof GitlabRoleConfig]
                      );
                    }}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      }
      case 'select': {
        const selectValue = typeof value === 'string' ? value : String(field.defaultValue ?? '');
        const selectOptions = field.options ?? [];
        return (
          <div key={String(field.key)} className="form-group">
            <label id={`${fieldId}-label`}>{field.label}</label>
            <Dropdown
              value={selectValue}
              options={selectOptions}
              onChange={v => updateConfigField(field.key as keyof GitlabRoleConfig, v)}
              aria-labelledby={`${fieldId}-label`}
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
    setTokenError(false);

    const parsed = parseGitlabUrl(gitlabUrl);
    if (!parsed) {
      setSaving(false);
      setError('GitLab 项目 URL 格式不正确，示例：https://gitlab.com/group/project');
      return;
    }
    if (!token.trim()) {
      setSaving(false);
      setTokenError(true);
      setTimeout(() => setTokenError(false), 2000);
      return;
    }

    try {
      const gitlabConfig = {
        baseUrl: parsed.baseUrl,
        projectPath: parsed.projectPath,
        token: token.trim(),
        defaultBranch: 'main',
      };

      // 先验证 GitLab 配置可用，验证通过后再落库，避免无效配置污染数据库
      await invoke('project.gitlab.verify', {
        projectId: project.id,
        gitlab: gitlabConfig,
      });

      await invoke('project.gitlab.config.update', {
        projectId: project.id,
        gitlab: gitlabConfig,
      });

      await loadSuggestions();

      // 从 project 中读取当前启用状态，避免保存时覆盖用户在卡片上切换的启停开关
      const currentRoleConfig = project.roles?.[role];
      const currentEnabled =
        currentRoleConfig?.role === 'archiver' ? false : (currentRoleConfig?.enabled ?? false);

      const nextConfig: GitlabRoleConfig = {
        ...config,
        enabled: currentEnabled,
        reviewSchedule: reviewSchedule.trim(),
        learningEnabled,
        filter: { conditions: filterConditions },
      };

      // 自动维护角色强制开启自动修复，并补齐风险等级默认值
      if (role === 'maintainer') {
        const mc = config as MaintainerConfig;
        (nextConfig as MaintainerConfig).autoFixEnabled = true;
        (nextConfig as MaintainerConfig).autoFixRiskLevels = Array.isArray(mc.autoFixRiskLevels)
          ? mc.autoFixRiskLevels
          : ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      }

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
      // 保存成功后只折叠 Git 仓库组，其他组保持当前折叠状态
      setGitExpanded(false);
      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (/\b(401|403)\b/.test(message)) {
        setTokenError(true);
        setTimeout(() => setTokenError(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  };

  const displaySoulFileName = ui.soulFileName;

  return (
    <div className="card" style={{ marginTop: 16, background: 'var(--main-bg)' }}>
      {error && (
        <div className="error-message" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <CollapsibleSection
        title="Git 仓库"
        defaultExpanded={true}
        expanded={gitExpanded}
        onToggle={() => setGitExpanded(prev => !prev)}
        collapsible={isGitlabReady}
        headerExtra={isGitlabReady ? <span className="badge badge-info">已配置</span> : null}
      >
        <div className="form-group">
          <label>GitLab 项目 URL</label>
          <div className="form-row">
            <input
              className="input"
              value={gitlabUrl}
              placeholder="https://gitlab.com/group/project"
              onChange={e => setGitlabUrl(e.target.value)}
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
          <div className="input-wrapper">
            <input
              type={showToken ? 'text' : 'password'}
              className={`input input-with-btn ${tokenError ? 'input-error input-flash' : ''}`}
              value={token}
              placeholder="请输入 GitLab Access Token"
              onChange={e => {
                setToken(e.target.value);
                if (tokenError) setTokenError(false);
              }}
            />
            <button
              type="button"
              className="input-inline-btn"
              onClick={() => setShowToken(prev => !prev)}
              aria-label={showToken ? '隐藏 Access Token' : '显示 Access Token'}
              title={showToken ? '隐藏' : '显示'}
            >
              {showToken ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          <div
            className={`input-hint ${tokenError ? 'input-hint-error' : ''}`}
            style={{ marginTop: 6 }}
          >
            {tokenError
              ? 'Access Token 不能为空'
              : '需要 api、read_repository、write_repository 权限以读取 MR 并发表评论'}
          </div>
        </div>
      </CollapsibleSection>

      {isGitlabReady && (
        <>
          <CollapsibleSection
            title="过滤条件"
            defaultExpanded={false}
            expanded={filterExpanded}
            onToggle={() => setFilterExpanded(prev => !prev)}
            headerExtra={
              <span className={`badge ${isFilterConfigured ? 'badge-success' : 'badge-warning'}`}>
                {isFilterConfigured ? '有过滤' : '无过滤'}
              </span>
            }
          >
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
                  options={FILTER_FIELD_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                  onChange={value => updateFilterField(index, value as FilterField)}
                  className="filter-field-dropdown"
                />
                {condition.field === 'draft' ? (
                  <Dropdown
                    value={condition.values[0] ?? 'false'}
                    options={DRAFT_OPTIONS}
                    onChange={value => updateDraftValue(index, value)}
                  />
                ) : condition.field === 'sourceBranch' ? (
                  <AutocompleteInput
                    value={condition.values[0] ?? ''}
                    options={branches}
                    placeholder="输入分支名，如 feature/my-branch"
                    loading={suggestLoading}
                    onChange={value => updateFilterValues(index, value)}
                  />
                ) : condition.field === 'targetBranch' ? (
                  <Dropdown
                    value={condition.values[0] ?? ''}
                    options={protectedBranches.map(b => ({ value: b, label: b }))}
                    onChange={value => updateFilterValues(index, value)}
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
                    onChange={value => updateFilterValues(index, value)}
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
            <button type="button" className="btn btn-primary btn-sm" onClick={addFilterCondition}>
              + 添加条件
            </button>
          </CollapsibleSection>

          <CollapsibleSection
            title="Agent 策略"
            defaultExpanded={false}
            expanded={agentExpanded}
            onToggle={() => setAgentExpanded(prev => !prev)}
            headerExtra={
              <span className={`badge ${isAgentDefault ? 'badge-info' : 'badge-success'}`}>
                {isAgentDefault ? '默认值' : '已配置'}
              </span>
            }
          >
            {ui.projectConfigFields.map(renderRoleField)}

            <div className="form-group">
              <label>自动学习模式</label>
              <Dropdown
                value={learningEnabled ? 'on' : 'off'}
                options={LEARNING_OPTIONS}
                onChange={value => updateConfigField('learningEnabled', value === 'on')}
              />
              <div className="project-meta" style={{ marginTop: 6 }}>
                开启后，Agent 会从人工 review、resolve/comment 行为中学习并优化后续策略。
              </div>
            </div>

            <div className="form-group">
              <label>调度间隔</label>
              <Dropdown
                value={isCustom ? 'custom' : reviewSchedule}
                options={REVIEW_INTERVALS.map(i => ({ value: i.cron, label: i.label }))}
                onChange={value => handleIntervalChange(value)}
              />
              {isCustom && (
                <input
                  className="input"
                  style={{ marginTop: 8 }}
                  value={customSchedule}
                  placeholder="*/10 * * * *"
                  onChange={e => handleCustomScheduleChange(e.target.value)}
                />
              )}
              <div className="project-meta" style={{ marginTop: 6 }}>
                当前 cron: {reviewSchedule}
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title={`Agent 个性配置（${displaySoulFileName}）`}
            defaultExpanded={false}
            expanded={soulExpanded}
            onToggle={() => setSoulExpanded(prev => !prev)}
            headerExtra={
              <span
                className={`badge ${
                  soulConfigStatus === 'full' ? 'badge-success' : 'badge-warning'
                }`}
              >
                {soulConfigStatus === 'full'
                  ? '有设定'
                  : soulConfigStatus === 'partial'
                    ? '仅部分'
                    : '无设定'}
              </span>
            }
          >
            <div className="form-group">
              <div
                className="form-row"
                style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}
              >
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
                style={{
                  minHeight: 240,
                  fontFamily: 'monospace',
                  lineHeight: 1.5,
                  resize: 'vertical',
                }}
                value={soulContent}
                placeholder="# Agent 个性配置&#10;## 风格&#10;..."
                onChange={e => setSoulContent(e.target.value)}
              />
              <div className="project-meta" style={{ marginTop: 6 }}>
                保存位置: {soulSourcePath}
              </div>
            </div>
          </CollapsibleSection>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving || !isGitlabValid}>
          {saving ? '保存中...' : '保存'}
        </button>
        {saved && <span className="badge badge-success">已保存</span>}
      </div>
    </div>
  );
}
