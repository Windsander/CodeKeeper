import { useState, useEffect } from 'react';
import { useIpc } from '../hooks/useIpc';
import { useServiceStatus } from '../hooks/useServiceStatus';
import { PageLayout } from '../components/PageLayout';
import { SettingsIcon } from '../components/icons';
import { ServiceStatusPanel } from '../components/ServiceStatusPanel';
import { Dropdown } from '../components/Dropdown';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_RERANK_MODEL,
  EMBEDDING_MODELS,
  RERANK_MODELS,
  isValidHuggingFaceModelId,
} from '../../shared/local-model-catalog.js';

interface DaemonConfig {
  apiKey: string;
  apiUrl: string;
  provider: string;
  model: string;
  headers: string;
  scanCron: string;
  llmRequestsPerMinute: number;
  embeddingModel: string;
  rerankModel: string;
  everos: string;
}

interface EverOSConfig {
  multimodalProvider?: 'anthropic' | 'openai';
  multimodalApiKey?: string;
  multimodalBaseUrl?: string;
  multimodalModel?: string;
  multimodalHeaders?: string;
}

interface HeaderEntry {
  key: string;
  value: string;
}

function parseHeaders(json: string): HeaderEntry[] {
  if (!json.trim()) return [];
  try {
    const obj = JSON.parse(json) as Record<string, string>;
    return Object.entries(obj).map(([key, value]) => ({ key, value }));
  } catch {
    return [];
  }
}

function stringifyHeaders(entries: HeaderEntry[]): string {
  const obj: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.key.trim()) {
      obj[entry.key.trim()] = entry.value;
    }
  }
  return JSON.stringify(obj);
}

function parseEverOS(json: string): EverOSConfig {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json) as EverOSConfig;
  } catch {
    return {};
  }
}

function stringifyEverOS(cfg: EverOSConfig): string {
  const cleaned: EverOSConfig = {};
  (Object.keys(cfg) as Array<keyof EverOSConfig>).forEach((key) => {
    const value = cfg[key];
    if (typeof value === 'string' && value.trim()) {
      (cleaned[key] as string | undefined) = value.trim();
    }
  });
  return JSON.stringify(cleaned);
}

const SCAN_INTERVALS = [
  { label: '每 1 分钟', cron: '*/1 * * * *' },
  { label: '每 5 分钟', cron: '*/5 * * * *' },
  { label: '每 15 分钟', cron: '*/15 * * * *' },
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每天', cron: '0 9 * * *' },
  { label: '自定义', cron: 'custom' },
];

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI 兼容' },
];

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  error?: boolean;
}

function SecretInput({ value, onChange, placeholder, ariaLabel, error }: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="input-wrapper">
      <input
        type={visible ? 'text' : 'password'}
        className={`input input-with-btn ${error ? 'input-error input-flash' : ''}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="input-inline-btn"
        onClick={() => setVisible((prev) => !prev)}
        aria-label={ariaLabel}
        title={visible ? '隐藏' : '显示'}
      >
        {visible ? (
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
  );
}

function Section({ title, badge, hideHeader, children }: { title: string; badge?: React.ReactNode; hideHeader?: boolean; children: React.ReactNode }) {
  return (
    <div className="config-section expanded">
      {!hideHeader && (
        <div className="config-section-header locked">
          <h5 className="config-section-title">{title}</h5>
          {badge}
        </div>
      )}
      <div className="config-section-body">{children}</div>
    </div>
  );
}

function LlmConfigSection({
  provider,
  setProvider,
  apiKey,
  setApiKey,
  apiUrl,
  setApiUrl,
  model,
  setModel,
  headerEntries,
  updateHeader,
  addHeader,
  removeHeader,
}: {
  provider: string;
  setProvider: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  apiUrl: string;
  setApiUrl: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  headerEntries: HeaderEntry[];
  updateHeader: (index: number, field: keyof HeaderEntry, value: string) => void;
  addHeader: () => void;
  removeHeader: (index: number) => void;
}) {
  return (
    <Section title="LLM 配置" hideHeader>
      <div className="form-group">
        <label>Provider</label>
        <Dropdown value={provider} options={PROVIDER_OPTIONS} onChange={(value) => setProvider(value)} />
      </div>

      <div className="form-group">
        <label>API Key</label>
        <SecretInput
          value={apiKey}
          onChange={setApiKey}
          placeholder="请输入 API Key"
          ariaLabel="Agent API Key 可见性切换"
        />
      </div>

      <div className="form-group">
        <label>API Base URL（可选）</label>
        <input
          className="input"
          value={apiUrl}
          placeholder="留空使用默认"
          onChange={(e) => setApiUrl(e.target.value)}
        />
        <div className="input-hint" style={{ marginTop: 6 }}>
          OpenAI 兼容示例：https://your-openai-proxy.example.com/v1
        </div>
      </div>

      <div className="form-group">
        <label>Model</label>
        <input
          className="input"
          value={model}
          placeholder={provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-20241022'}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>自定义 Headers</label>
        {headerEntries.map((entry, index) => (
          <div key={index} className="form-row header-entry-row" style={{ marginBottom: 8 }}>
            <input
              className="input"
              placeholder="Header 名称"
              value={entry.key}
              onChange={(e) => updateHeader(index, 'key', e.target.value)}
            />
            <input
              className="input"
              placeholder="Header 值"
              value={entry.value}
              onChange={(e) => updateHeader(index, 'value', e.target.value)}
            />
            <button
              type="button"
              className="btn btn-danger btn-sm header-entry-remove"
              onClick={() => removeHeader(index)}
              title="删除"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
        ))}
        <button className="btn btn-primary btn-sm" onClick={addHeader}>+ 添加 Header</button>
      </div>
    </Section>
  );
}

function DaemonScheduleSection({
  scanCron,
  setScanCron,
  customCron,
  setCustomCron,
  llmRequestsPerMinute,
  setLlmRequestsPerMinute,
}: {
  scanCron: string;
  setScanCron: (value: string) => void;
  customCron: string;
  setCustomCron: (value: string) => void;
  llmRequestsPerMinute: number;
  setLlmRequestsPerMinute: (value: number) => void;
}) {
  const isCustomCron = !SCAN_INTERVALS.some((i) => i.cron === scanCron && i.cron !== 'custom');

  const handleIntervalChange = (value: string) => {
    if (value === 'custom') {
      setScanCron(customCron);
    } else {
      setScanCron(value);
      setCustomCron(value);
    }
  };

  const handleCustomCronChange = (value: string) => {
    setCustomCron(value);
    setScanCron(value);
  };

  return (
    <Section title="Daemon 调度" hideHeader>
      <div className="form-group">
        <label>扫描间隔</label>
        <Dropdown
          value={isCustomCron ? 'custom' : scanCron}
          options={SCAN_INTERVALS.map((i) => ({ value: i.cron, label: i.label }))}
          onChange={(value) => handleIntervalChange(value)}
        />
        {isCustomCron && (
          <input
            className="input"
            style={{ marginTop: 8 }}
            value={customCron}
            placeholder="*/5 * * * *"
            onChange={(e) => handleCustomCronChange(e.target.value)}
          />
        )}
        <div className="input-hint" style={{ marginTop: 6 }}>当前 cron: {scanCron}</div>
      </div>

      <div className="form-group">
        <label>LLM 每分钟请求数限制</label>
        <input
          type="number"
          className="input"
          min={1}
          max={600}
          value={llmRequestsPerMinute}
          onChange={(e) => setLlmRequestsPerMinute(Math.max(1, Number(e.target.value) || 10))}
        />
        <div className="input-hint" style={{ marginTop: 6 }}>
          请求间隔约 {Math.ceil(60000 / llmRequestsPerMinute)}ms
        </div>
      </div>
    </Section>
  );
}

function LocalModelsSection({
  embeddingModel,
  setEmbeddingModel,
  rerankModel,
  setRerankModel,
  embeddingCustom,
  setEmbeddingCustom,
  rerankCustom,
  setRerankCustom,
  localModelStatus,
}: {
  embeddingModel: string;
  setEmbeddingModel: (value: string) => void;
  rerankModel: string;
  setRerankModel: (value: string) => void;
  embeddingCustom: string;
  setEmbeddingCustom: (value: string) => void;
  rerankCustom: string;
  setRerankCustom: (value: string) => void;
  localModelStatus: ReturnType<typeof useServiceStatus>['localModel'];
}) {
  const embeddingState = localModelStatus?.embedding.state ?? 'idle';
  const embeddingUrl = localModelStatus?.embedding.url ?? null;
  const embeddingError = localModelStatus?.embedding.error ?? null;
  const rerankState = localModelStatus?.rerank.state ?? 'idle';
  const rerankUrl = localModelStatus?.rerank.url ?? null;
  const rerankError = localModelStatus?.rerank.error ?? null;

  const renderStatusHint = (state: string, url: string | null, error: string | null) => {
    if (error) return `错误: ${error.slice(0, 120)}${error.length > 120 ? '...' : ''}`;
    if (state === 'running' && url) return `运行中 ${url}`;
    if (state === 'running') return '运行中';
    if (state === 'starting') return '启动中';
    if (state === 'downloading') return '模型下载中';
    if (state === 'loading') return '模型加载中';
    return '未启动';
  };

  return (
    <Section
      title="本地 Embedding/Rerank 模型"
      hideHeader
      badge={
        embeddingState === 'running' && rerankState === 'running' ? (
          <span className="badge badge-success">运行中</span>
        ) : (
          <span className="badge badge-info">本地推理</span>
        )
      }
    >
      <div className="form-group">
        <label>Embedding 模型</label>
        <Dropdown
          value={EMBEDDING_MODELS.includes(embeddingModel) ? embeddingModel : 'custom'}
          options={[...EMBEDDING_MODELS.map((m) => ({ value: m, label: m })), { value: 'custom', label: '自定义' }]}
          onChange={(value) => {
            if (value === 'custom') {
              setEmbeddingModel(embeddingCustom || '');
            } else {
              setEmbeddingModel(value);
            }
          }}
        />
        {(!EMBEDDING_MODELS.includes(embeddingModel) || embeddingCustom) && (
          <input
            className="input"
            style={{ marginTop: 8 }}
            placeholder="HuggingFace 模型名，例如 organization/model-name"
            value={EMBEDDING_MODELS.includes(embeddingModel) ? embeddingCustom : embeddingModel}
            onChange={(e) => {
              const value = e.target.value;
              if (EMBEDDING_MODELS.includes(embeddingModel)) {
                setEmbeddingCustom(value);
              } else {
                setEmbeddingModel(value);
              }
            }}
          />
        )}
        <div className="input-hint" style={{ marginTop: 6 }}>
          状态: {renderStatusHint(embeddingState, embeddingUrl, embeddingError)}
        </div>
      </div>

      <div className="form-group">
        <label>Rerank 模型</label>
        <Dropdown
          value={RERANK_MODELS.includes(rerankModel) ? rerankModel : 'custom'}
          options={[...RERANK_MODELS.map((m) => ({ value: m, label: m })), { value: 'custom', label: '自定义' }]}
          onChange={(value) => {
            if (value === 'custom') {
              setRerankModel(rerankCustom || '');
            } else {
              setRerankModel(value);
            }
          }}
        />
        {(!RERANK_MODELS.includes(rerankModel) || rerankCustom) && (
          <input
            className="input"
            style={{ marginTop: 8 }}
            placeholder="HuggingFace 模型名"
            value={RERANK_MODELS.includes(rerankModel) ? rerankCustom : rerankModel}
            onChange={(e) => {
              const value = e.target.value;
              if (RERANK_MODELS.includes(rerankModel)) {
                setRerankCustom(value);
              } else {
                setRerankModel(value);
              }
            }}
          />
        )}
        <div className="input-hint" style={{ marginTop: 6 }}>
          状态: {renderStatusHint(rerankState, rerankUrl, rerankError)}
        </div>
      </div>
    </Section>
  );
}

function MultimodalConfigSection({
  provider,
  setProvider,
  apiKey,
  setApiKey,
  apiUrl,
  setApiUrl,
  model,
  setModel,
  headerEntries,
  updateHeader,
  addHeader,
  removeHeader,
}: {
  provider: string;
  setProvider: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  apiUrl: string;
  setApiUrl: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  headerEntries: HeaderEntry[];
  updateHeader: (index: number, field: keyof HeaderEntry, value: string) => void;
  addHeader: () => void;
  removeHeader: (index: number) => void;
}) {
  const hasCustom =
    provider.trim() ||
    apiKey.trim() ||
    apiUrl.trim() ||
    model.trim() ||
    headerEntries.some((e) => e.key.trim() || e.value.trim());

  return (
    <Section
      title="多模态模型"
      hideHeader
      badge={hasCustom ? <span className="badge badge-success">已自定义</span> : <span className="badge badge-secondary">未配置</span>}
    >
      <div className="form-group">
        <label>Provider</label>
        <Dropdown value={provider} options={PROVIDER_OPTIONS} onChange={(value) => setProvider(value)} />
      </div>

      <div className="form-group">
        <label>API Key</label>
        <SecretInput
          value={apiKey}
          onChange={setApiKey}
          placeholder="请输入多模态模型 API Key"
          ariaLabel="多模态 API Key 可见性切换"
        />
      </div>

      <div className="form-group">
        <label>API Base URL（可选）</label>
        <input
          className="input"
          value={apiUrl}
          placeholder="留空使用默认"
          onChange={(e) => setApiUrl(e.target.value)}
        />
        <div className="input-hint" style={{ marginTop: 6 }}>
          OpenAI 兼容示例：https://your-openai-proxy.example.com/v1
        </div>
      </div>

      <div className="form-group">
        <label>Model</label>
        <input
          className="input"
          value={model}
          placeholder={provider === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022'}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label>自定义 Headers</label>
        {headerEntries.map((entry, index) => (
          <div key={index} className="form-row header-entry-row" style={{ marginBottom: 8 }}>
            <input
              className="input"
              placeholder="Header 名称"
              value={entry.key}
              onChange={(e) => updateHeader(index, 'key', e.target.value)}
            />
            <input
              className="input"
              placeholder="Header 值"
              value={entry.value}
              onChange={(e) => updateHeader(index, 'value', e.target.value)}
            />
            <button
              type="button"
              className="btn btn-danger btn-sm header-entry-remove"
              onClick={() => removeHeader(index)}
              title="删除"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
        ))}
        <button className="btn btn-primary btn-sm" onClick={addHeader}>+ 添加 Header</button>
      </div>
    </Section>
  );
}

export function Settings() {
  const { data, loading, refresh } = useIpc<DaemonConfig>('daemon.config');
  const serviceStatus = useServiceStatus();

  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>([{ key: '', value: '' }]);
  const [scanCron, setScanCron] = useState('*/5 * * * *');
  const [customCron, setCustomCron] = useState('*/5 * * * *');
  const [llmRequestsPerMinute, setLlmRequestsPerMinute] = useState(10);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [multimodalProvider, setMultimodalProvider] = useState('anthropic');
  const [multimodalApiKey, setMultimodalApiKey] = useState('');
  const [multimodalApiUrl, setMultimodalApiUrl] = useState('');
  const [multimodalModel, setMultimodalModel] = useState('');
  const [multimodalHeaderEntries, setMultimodalHeaderEntries] = useState<HeaderEntry[]>([{ key: '', value: '' }]);

  const [embeddingModel, setEmbeddingModel] = useState(DEFAULT_EMBEDDING_MODEL);
  const [rerankModel, setRerankModel] = useState(DEFAULT_RERANK_MODEL);
  const [embeddingCustom, setEmbeddingCustom] = useState('');
  const [rerankCustom, setRerankCustom] = useState('');
  const [localModelError, setLocalModelError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setScanCron(data.scanCron);
      setCustomCron(data.scanCron);
      setApiKey(data.apiKey ?? '');
      setApiUrl(data.apiUrl ?? '');
      setProvider(data.provider ?? 'anthropic');
      setModel(data.model ?? '');
      setLlmRequestsPerMinute(data.llmRequestsPerMinute ?? 10);
      const entries = parseHeaders(data.headers ?? '');
      setHeaderEntries(entries.length > 0 ? entries : [{ key: '', value: '' }]);
      setEmbeddingModel(data.embeddingModel ?? DEFAULT_EMBEDDING_MODEL);
      setRerankModel(data.rerankModel ?? DEFAULT_RERANK_MODEL);

      const parsedEveros = parseEverOS(data.everos ?? '');
      setMultimodalProvider(parsedEveros.multimodalProvider ?? 'anthropic');
      setMultimodalApiKey(parsedEveros.multimodalApiKey ?? '');
      setMultimodalApiUrl(parsedEveros.multimodalBaseUrl ?? '');
      setMultimodalModel(parsedEveros.multimodalModel ?? '');
      const mmEntries = parseHeaders(parsedEveros.multimodalHeaders ?? '');
      setMultimodalHeaderEntries(mmEntries.length > 0 ? mmEntries : [{ key: '', value: '' }]);
    }
  }, [data]);

  const updateHeader = (index: number, field: keyof HeaderEntry, value: string) => {
    setHeaderEntries((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addHeader = () => {
    setHeaderEntries((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeHeader = (index: number) => {
    setHeaderEntries((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ key: '', value: '' }];
    });
  };

  const updateMultimodalHeader = (index: number, field: keyof HeaderEntry, value: string) => {
    setMultimodalHeaderEntries((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const addMultimodalHeader = () => {
    setMultimodalHeaderEntries((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeMultimodalHeader = (index: number) => {
    setMultimodalHeaderEntries((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [{ key: '', value: '' }];
    });
  };

  const save = async () => {
    setSaved(false);
    setSaving(true);
    setLocalModelError(null);

    const finalEmbedding = EMBEDDING_MODELS.includes(embeddingModel)
      ? embeddingModel
      : embeddingModel || embeddingCustom;
    const finalRerank = RERANK_MODELS.includes(rerankModel) ? rerankModel : rerankModel || rerankCustom;

    if (!isValidHuggingFaceModelId(finalEmbedding)) {
      setLocalModelError(`Embedding 模型名不合法: ${finalEmbedding}`);
      setSaving(false);
      return;
    }
    if (!isValidHuggingFaceModelId(finalRerank)) {
      setLocalModelError(`Rerank 模型名不合法: ${finalRerank}`);
      setSaving(false);
      return;
    }

    const payload: {
      apiKey: string;
      apiUrl?: string;
      provider?: string;
      model?: string;
      headers?: string;
      scanCron: string;
      llmRequestsPerMinute: number;
      embeddingModel: string;
      rerankModel: string;
      everos?: string;
    } = {
      apiKey: apiKey.trim(),
      scanCron,
      llmRequestsPerMinute,
      embeddingModel: finalEmbedding,
      rerankModel: finalRerank,
    };

    if (apiUrl.trim()) payload.apiUrl = apiUrl.trim();
    if (provider.trim()) payload.provider = provider.trim();
    if (model.trim()) payload.model = model.trim();

    const headers = stringifyHeaders(headerEntries);
    if (headers !== '{}') payload.headers = headers;

    const mmHeaders = stringifyHeaders(multimodalHeaderEntries);
    const everosCfg: EverOSConfig = {};
    if (multimodalProvider.trim()) everosCfg.multimodalProvider = multimodalProvider.trim() as 'anthropic' | 'openai';
    if (multimodalApiKey.trim()) everosCfg.multimodalApiKey = multimodalApiKey.trim();
    if (multimodalApiUrl.trim()) everosCfg.multimodalBaseUrl = multimodalApiUrl.trim();
    if (multimodalModel.trim()) everosCfg.multimodalModel = multimodalModel.trim();
    if (mmHeaders !== '{}') everosCfg.multimodalHeaders = mmHeaders;

    const everosJson = stringifyEverOS(everosCfg);
    if (everosJson !== '{}') payload.everos = everosJson;

    try {
      await window.electronAPI.invoke('daemon.config.update', payload);
      setSaved(true);
    } finally {
      setSaving(false);
      refresh();
    }
  };

  const [activeTab, setActiveTab] = useState<'llm' | 'multimodal' | 'local' | 'daemon'>('llm');

  const TABS = [
    { key: 'llm' as const, label: '大语言模型' },
    { key: 'multimodal' as const, label: '多模态模型' },
    { key: 'local' as const, label: '本地辅助模型' },
    { key: 'daemon' as const, label: '扫描调度' },
  ];

  const TAB_DESCRIPTIONS: Record<'llm' | 'multimodal' | 'local' | 'daemon', string> = {
    llm: '配置 Agent 通用 LLM，用于评审、修复建议与归档推理。未填写 API Key 时相关功能不可用。',
    multimodal: '用于解析图片 / PDF / 音频。未配置时不会向 EverOS 传入多模态覆盖。',
    local: '配置本地 Embedding / Rerank 模型，为 EverOS 记忆检索提供向量服务。',
    daemon: '配置后台扫描周期与 LLM 请求速率限制。修改后会自动应用到正在运行的 Daemon。',
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'llm':
        return (
          <LlmConfigSection
            provider={provider}
            setProvider={setProvider}
            apiKey={apiKey}
            setApiKey={setApiKey}
            apiUrl={apiUrl}
            setApiUrl={setApiUrl}
            model={model}
            setModel={setModel}
            headerEntries={headerEntries}
            updateHeader={updateHeader}
            addHeader={addHeader}
            removeHeader={removeHeader}
          />
        );
      case 'daemon':
        return (
          <DaemonScheduleSection
            scanCron={scanCron}
            setScanCron={setScanCron}
            customCron={customCron}
            setCustomCron={setCustomCron}
            llmRequestsPerMinute={llmRequestsPerMinute}
            setLlmRequestsPerMinute={setLlmRequestsPerMinute}
          />
        );
      case 'local':
        return (
          <LocalModelsSection
            embeddingModel={embeddingModel}
            setEmbeddingModel={setEmbeddingModel}
            rerankModel={rerankModel}
            setRerankModel={setRerankModel}
            embeddingCustom={embeddingCustom}
            setEmbeddingCustom={setEmbeddingCustom}
            rerankCustom={rerankCustom}
            setRerankCustom={setRerankCustom}
            localModelStatus={serviceStatus.localModel}
          />
        );
      case 'multimodal':
        return (
          <MultimodalConfigSection
            provider={multimodalProvider}
            setProvider={setMultimodalProvider}
            apiKey={multimodalApiKey}
            setApiKey={setMultimodalApiKey}
            apiUrl={multimodalApiUrl}
            setApiUrl={setMultimodalApiUrl}
            model={multimodalModel}
            setModel={setMultimodalModel}
            headerEntries={multimodalHeaderEntries}
            updateHeader={updateMultimodalHeader}
            addHeader={addMultimodalHeader}
            removeHeader={removeMultimodalHeader}
          />
        );
    }
  };

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <PageLayout icon={<SettingsIcon />} title="设置">
      <div className="settings-layout">
        <div className="settings-form-column">
          <div className="card">
            <div className="tabs settings-tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`tab-btn${activeTab === tab.key ? ' active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <p className="tab-description">{TAB_DESCRIPTIONS[activeTab]}</p>

            <div className="settings-tab-content">{renderTabContent()}</div>

            {localModelError && (
              <div className="input-hint" style={{ marginTop: 12, color: 'var(--danger)' }}>
                {localModelError}
              </div>
            )}

            <div className="settings-save-bar">
              {saved && <span className="badge badge-success">已保存</span>}
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>

        <div className="settings-status-column">
          <ServiceStatusPanel
            daemon={serviceStatus.daemon}
            localModel={serviceStatus.localModel}
            remoteModel={serviceStatus.remoteModel}
          />
        </div>
      </div>
    </PageLayout>
  );
}
