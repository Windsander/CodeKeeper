import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke, openExternal } from '../api/electron-api.js';
import { Dropdown } from './Dropdown.js';
import { createDefaultArchiverConfig } from '../roles/archiver-defaults.js';
import type {
  ArchiverConfig,
  ArchiverProviderDescriptor,
  ArchiverProviderProbeResult,
  ArchiverProviderRunReport,
  Project,
} from '../../shared/types.js';

interface ArchiverProviderConfigProps {
  project: Project;
  onSaved: () => void;
}

interface CatalogResponse {
  providers: ArchiverProviderDescriptor[];
}

interface ProbeResponse {
  providers: ArchiverProviderProbeResult[];
}

interface StatusResponse {
  status: ArchiverProviderRunReport | null;
}

type ScheduleMode = 'daily' | 'six-hours' | 'hourly' | 'custom';

const SCHEDULES = [
  { value: 'daily', label: '每天 02:00', cron: '0 2 * * *' },
  { value: 'six-hours', label: '每 6 小时', cron: '0 */6 * * *' },
  { value: 'hourly', label: '每小时', cron: '0 * * * *' },
] as const;

const STATUS_LABELS: Record<string, string> = {
  selected: '已选用',
  completed: '已完成',
  unavailable: '不可用',
  failed: '失败',
  skipped: '已跳过',
  deferred: '待后续阶段',
};

function normalizeConfig(value: unknown): ArchiverConfig {
  const defaults = createDefaultArchiverConfig();
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Record<string, unknown>;
  const automation =
    raw.automation && typeof raw.automation === 'object'
      ? (raw.automation as Record<string, unknown>)
      : {};
  const legacyCron = typeof raw.reviewSchedule === 'string' ? raw.reviewSchedule : undefined;
  return {
    role: 'archiver',
    schemaVersion: 3,
    archiverName:
      typeof raw.archiverName === 'string' && raw.archiverName.trim()
        ? raw.archiverName.trim()
        : defaults.archiverName,
    automation: {
      enabled:
        typeof automation.enabled === 'boolean'
          ? automation.enabled
          : typeof raw.enabled === 'boolean'
            ? raw.enabled
            : defaults.automation.enabled,
      cron:
        typeof automation.cron === 'string' && automation.cron.trim()
          ? automation.cron.trim()
          : legacyCron?.trim() || defaults.automation.cron,
    },
  };
}

function detectSchedule(cron: string): ScheduleMode {
  return SCHEDULES.find(item => item.cron === cron)?.value ?? 'custom';
}

function formatTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '';
}

function statusLabel(status: ArchiverProviderRunReport['statuses'][number] | undefined): string {
  return status ? (STATUS_LABELS[status.state] ?? status.state) : '尚无运行记录';
}

function providerKindLabel(kind: ArchiverProviderDescriptor['kind']): string {
  return kind === 'builtin' ? '内置' : kind === 'skill' ? 'Skill' : 'Provider';
}

function availabilityLabel(
  provider: ArchiverProviderDescriptor,
  probe: ArchiverProviderProbeResult | undefined
): string {
  if (!probe) return '检测中';
  if (probe.readiness === 'manual') return probe.prepared ? '已准备·需手动' : '需手动';
  if (probe.readiness === 'preparing') return '准备中';
  if (probe.readiness === 'preparable') return '可自动准备';
  if (probe.available) return '可用';
  if (provider.preparation === 'managed') return '准备失败';
  return '不可用';
}

export function ArchiverProviderConfig({ project, onSaved }: ArchiverProviderConfigProps) {
  const defaults = createDefaultArchiverConfig();
  const [config, setConfig] = useState<ArchiverConfig>(defaults);
  const [savedName, setSavedName] = useState(defaults.archiverName);
  const [providers, setProviders] = useState<ArchiverProviderDescriptor[]>([]);
  const [probes, setProbes] = useState<Record<string, ArchiverProviderProbeResult>>({});
  const [status, setStatus] = useState<ArchiverProviderRunReport | null>(null);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('daily');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const latestStatuses = useMemo(
    () => new Map(status?.statuses.map(item => [item.providerId, item]) ?? []),
    [status]
  );
  const selectedProvider = useMemo(
    () => providers.find(provider => provider.id === status?.selectedPrimary),
    [providers, status?.selectedPrimary]
  );

  const probeProviders = useCallback(async () => {
    setProbing(true);
    try {
      const response = await invoke<ProbeResponse>('archiver.provider.probe', {
        projectId: project.id,
      });
      setProbes(Object.fromEntries(response.providers.map(item => [item.providerId, item])));
    } catch {
      setProbes({});
    } finally {
      setProbing(false);
    }
  }, [project.id]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const [configResponse, catalogResponse, statusResponse] = await Promise.all([
          invoke<{ config: unknown }>('project.role.config.get', {
            projectId: project.id,
            role: 'archiver',
          }),
          invoke<CatalogResponse>('archiver.provider.catalog').catch(() => ({ providers: [] })),
          invoke<StatusResponse>('archiver.provider.status', { projectId: project.id }).catch(
            () => ({ status: null })
          ),
        ]);
        if (disposed) return;
        const normalized = normalizeConfig(configResponse.config);
        setConfig(normalized);
        setSavedName(normalized.archiverName);
        setScheduleMode(detectSchedule(normalized.automation.cron));
        setProviders(catalogResponse.providers);
        setStatus(statusResponse.status);
        void probeProviders();
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [probeProviders, project.id]);

  const changeSchedule = (value: string) => {
    if (value === 'custom') {
      setScheduleMode('custom');
      return;
    }
    const preset = SCHEDULES.find(item => item.value === value);
    if (!preset) return;
    setScheduleMode(preset.value);
    setConfig(previous => ({
      ...previous,
      automation: { ...previous.automation, cron: preset.cron },
    }));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    const nextConfig: ArchiverConfig = {
      role: 'archiver',
      schemaVersion: 3,
      archiverName: config.archiverName.trim() || defaults.archiverName,
      automation: {
        enabled: config.automation.enabled,
        cron: config.automation.cron.trim() || defaults.automation.cron,
      },
    };
    try {
      await invoke('project.role.config.update', {
        projectId: project.id,
        role: 'archiver',
        config: nextConfig,
      });
      setConfig(nextConfig);
      setSavedName(nextConfig.archiverName);
      setScheduleMode(detectSchedule(nextConfig.automation.cron));
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className='archiver-v2-panel'>
        <div className='loading'>加载项目知识配置...</div>
      </div>
    );
  }

  const nameChanged = config.archiverName.trim() !== savedName.trim();
  const scheduleOptions = [
    ...SCHEDULES.map(item => ({ value: item.value, label: item.label })),
    { value: 'custom', label: '自定义 cron' },
  ];

  return (
    <div className='archiver-v2-panel'>
      {error && <div className='error-message'>{error}</div>}
      {saved && <div className='success-message'>项目知识配置已保存。</div>}

      <section className='archiver-v2-section'>
        <div className='archiver-v2-section-heading'>
          <div>
            <h3>Archiver 身份</h3>
            <p>该名称会作为 Archiver Role 写入 EverOS 的 Agent 身份。</p>
          </div>
        </div>
        <div className='form-group archiver-v2-name-field'>
          <label htmlFor='archiver-name'>Archiver 名称</label>
          <input
            id='archiver-name'
            className='input'
            value={config.archiverName}
            onChange={event =>
              setConfig(previous => ({
                ...previous,
                archiverName: event.target.value,
              }))
            }
            placeholder={defaults.archiverName}
          />
        </div>
        {nameChanged && (
          <div className='archiver-v2-warning'>
            修改名称会创建新的 EverOS Agent 身份，旧记忆不会自动迁移。
          </div>
        )}
      </section>

      <section className='archiver-v2-section'>
        <div className='archiver-v2-section-heading'>
          <div>
            <h3>自动归档</h3>
            <p>只需选择更新频率；Provider 的安装、启动和回退由系统自动处理。</p>
          </div>
        </div>
        <div className='archiver-v2-schedule-row'>
          <div>
            <strong>更新频率</strong>
            <span>系统会自动选择可用知识源，并持续整理代码与文档知识。</span>
          </div>
          <Dropdown
            value={scheduleMode}
            options={scheduleOptions}
            onChange={changeSchedule}
            className='archiver-v2-dropdown'
          />
        </div>
        {scheduleMode === 'custom' && (
          <div className='form-group archiver-v2-cron-field'>
            <label htmlFor='archiver-cron'>cron 表达式</label>
            <input
              id='archiver-cron'
              className='input'
              value={config.automation.cron}
              onChange={event =>
                setConfig(previous => ({
                  ...previous,
                  automation: { ...previous.automation, cron: event.target.value },
                }))
              }
              placeholder='0 2 * * *'
            />
          </div>
        )}
      </section>

      <section className='archiver-v2-section'>
        <div className='archiver-v2-section-heading'>
          <div>
            <h3>自动知识方案</h3>
            <p>无需选择 Provider。系统按内置优先级探测环境，自动完成主源、回退和文档知识提炼。</p>
          </div>
        </div>
        <div className='archiver-v2-auto-summary'>
          <strong>
            {selectedProvider
              ? `当前主知识源：${selectedProvider.displayName}`
              : '系统自动遴选知识源'}
          </strong>
          <span>
            默认优先结构探索 Provider；不可用时自动回退，并始终保留内置文档知识提炼。交互式
            Skill 只自动准备资源，由 Agent 工作流执行。
          </span>
        </div>
      </section>

      <section className='archiver-v2-section'>
        <div className='archiver-v2-section-heading'>
          <div>
            <h3>Provider 诊断</h3>
            <p>仅展示系统自动探测结果，不显示启动命令、参数、环境变量或路径。</p>
          </div>
          <button
            type='button'
            className='btn btn-secondary btn-sm'
            onClick={() => void probeProviders()}
            disabled={probing}
          >
            {probing ? '检测中...' : '重新检测'}
          </button>
        </div>
        <div className='archiver-v2-diagnostics'>
          {providers.map(provider => {
            const probe = probes[provider.id];
            const runStatus = latestStatuses.get(provider.id);
            const statusClass =
              probe?.available || probe?.readiness === 'manual'
                ? 'badge-success'
                : probe?.readiness === 'preparable' || probe?.readiness === 'preparing'
                  ? 'badge-info'
                  : probe
                    ? 'badge-warning'
                    : 'badge-info';
            return (
              <article className='archiver-v2-diagnostic-card' key={provider.id}>
                <div className='archiver-v2-diagnostic-header'>
                  <div>
                    <strong>{provider.displayName}</strong>
                    <span>{providerKindLabel(provider.kind)}</span>
                  </div>
                  <span className={`badge ${statusClass}`}>
                    {availabilityLabel(provider, probe)}
                  </span>
                </div>
                <p>{provider.description}</p>
                <div className='archiver-v2-diagnostic-meta'>
                  <span>版本：{probe?.version ?? '—'}</span>
                  <span>最近状态：{statusLabel(runStatus)}</span>
                  {runStatus?.finishedAt && <span>{formatTime(runStatus.finishedAt)}</span>}
                </div>
                {probe?.message && (
                  <span className='archiver-v2-diagnostic-message'>{probe.message}</span>
                )}
                {provider.homepage && (
                  <button
                    type='button'
                    className='archiver-v2-homepage'
                    onClick={() => void openExternal(provider.homepage)}
                  >
                    查看 Provider 主页
                  </button>
                )}
              </article>
            );
          })}
          {providers.length === 0 && (
            <div className='archiver-v2-empty'>
              Provider 目录暂不可用，系统仍会使用内置知识阶段。
            </div>
          )}
        </div>
      </section>

      <div className='archiver-v2-actions'>
        <button
          type='button'
          className='btn btn-primary'
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
        {saved && <span className='badge badge-success'>已保存</span>}
      </div>
    </div>
  );
}
