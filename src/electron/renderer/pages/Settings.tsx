import { useState, useEffect } from 'react';
import { useIpc } from '../hooks/useIpc';

interface DaemonConfig {
  apiKey: string;
  apiUrl: string;
  provider: string;
  model: string;
  headers: string;
  scanCron: string;
  llmRequestsPerMinute: number;
  everos: string;
}

interface EverOSConfig {
  llmModel?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  embeddingModel?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  multimodalModel?: string;
  multimodalApiKey?: string;
  multimodalBaseUrl?: string;
  rerankModel?: string;
  rerankApiKey?: string;
  rerankBaseUrl?: string;
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
      cleaned[key] = value.trim();
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

interface EverosFieldGroupProps {
  title: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  modelPlaceholder: string;
  apiKeyPlaceholder: string;
  baseUrlPlaceholder: string;
  onModelChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
}

function EverosFieldGroup({
  title,
  model,
  apiKey,
  baseUrl,
  modelPlaceholder,
  apiKeyPlaceholder,
  baseUrlPlaceholder,
  onModelChange,
  onApiKeyChange,
  onBaseUrlChange,
}: EverosFieldGroupProps) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div className="form-group" style={{ borderLeft: '3px solid var(--primary)', paddingLeft: 12 }}>
      <label style={{ fontWeight: 600 }}>{title}</label>
      <input
        className="input"
        placeholder={modelPlaceholder}
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
        style={{ marginBottom: 8 }}
      />
      <div className="input-group" style={{ marginBottom: 8 }}>
        <input
          type={showKey ? 'text' : 'password'}
          className="input"
          placeholder={apiKeyPlaceholder}
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
        />
        <button
          type="button"
          className="input-group-btn"
          onClick={() => setShowKey((prev) => !prev)}
          aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
          title={showKey ? '隐藏' : '显示'}
        >
          {showKey ? (
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
      <input
        className="input"
        placeholder={baseUrlPlaceholder}
        value={baseUrl}
        onChange={(e) => onBaseUrlChange(e.target.value)}
      />
    </div>
  );
}

export function Settings() {
  const { data, loading, refresh } = useIpc<DaemonConfig>('daemon.config');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [headerEntries, setHeaderEntries] = useState<HeaderEntry[]>([{ key: '', value: '' }]);
  const [scanCron, setScanCron] = useState('*/5 * * * *');
  const [customCron, setCustomCron] = useState('*/5 * * * *');
  const [llmRequestsPerMinute, setLlmRequestsPerMinute] = useState(10);
  const [saved, setSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const [everos, setEveros] = useState<EverOSConfig>({});

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
      setEveros(parseEverOS(data.everos ?? ''));
    }
  }, [data]);

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

  const isCustom = !SCAN_INTERVALS.some((i) => i.cron === scanCron && i.cron !== 'custom');

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

  const updateEveros = (patch: Partial<EverOSConfig>) => {
    setEveros((prev) => ({ ...prev, ...patch }));
  };

  const save = async () => {
    setSaved(false);
    const payload: {
      apiKey: string;
      apiUrl?: string;
      provider?: string;
      model?: string;
      headers?: string;
      scanCron: string;
      llmRequestsPerMinute: number;
      everos?: string;
    } = { apiKey: apiKey.trim(), scanCron, llmRequestsPerMinute };

    if (apiUrl.trim()) payload.apiUrl = apiUrl.trim();
    if (provider.trim()) payload.provider = provider.trim();
    if (model.trim()) payload.model = model.trim();

    const headers = stringifyHeaders(headerEntries);
    if (headers !== '{}') payload.headers = headers;

    const everosJson = stringifyEverOS(everos);
    if (everosJson !== '{}') payload.everos = everosJson;

    await window.electronAPI.invoke('daemon.config.update', payload);
    setSaved(true);
    refresh();
  };

  if (loading) return <div className="loading">加载中...</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">设置</h1>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <h2 style={{ marginBottom: 16 }}>Agent 通用配置</h2>

        <div className="form-group">
          <label>Provider</label>
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI 兼容</option>
          </select>
        </div>

        <div className="form-group">
          <label>API Key</label>
          <div className="input-group">
            <input
              type={showApiKey ? 'text' : 'password'}
              className="input"
              value={apiKey}
              placeholder="请输入 API Key"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              type="button"
              className="input-group-btn"
              onClick={() => setShowApiKey((prev) => !prev)}
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              title={showApiKey ? '隐藏' : '显示'}
            >
              {showApiKey ? (
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
        </div>

        <div className="form-group">
          <label>API Base URL（可选）</label>
          <input
            className="input"
            value={apiUrl}
            placeholder="https://api.anthropic.com（留空使用默认）"
            onChange={(e) => setApiUrl(e.target.value)}
          />
          <div className="project-meta" style={{ marginTop: 6 }}>
            OpenAI 兼容示例：https://your-openai-proxy.example.com/v1/chat/completions
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
            <div key={index} className="form-row" style={{ marginBottom: 8 }}>
              <input
                className="input"
                placeholder="Header 名称，如 X-Model-Request-Id"
                value={entry.key}
                onChange={(e) => updateHeader(index, 'key', e.target.value)}
              />
              <input
                className="input"
                placeholder="Header 值，如 1234"
                value={entry.value}
                onChange={(e) => updateHeader(index, 'value', e.target.value)}
              />
              <button className="btn btn-danger btn-sm" onClick={() => removeHeader(index)}>删除</button>
            </div>
          ))}
          <button className="btn btn-primary btn-sm" onClick={addHeader}>+ 添加 Header</button>
        </div>

        <div className="form-group">
          <label>扫描间隔</label>
          <select
            className="input"
            value={isCustom ? 'custom' : scanCron}
            onChange={(e) => handleIntervalChange(e.target.value)}
          >
            {SCAN_INTERVALS.map((item) => (
              <option key={item.cron} value={item.cron}>
                {item.label}
              </option>
            ))}
          </select>
          {isCustom && (
            <input
              className="input"
              style={{ marginTop: 8 }}
              value={customCron}
              placeholder="*/5 * * * *"
              onChange={(e) => handleCustomCronChange(e.target.value)}
            />
          )}
          <div className="project-meta" style={{ marginTop: 6 }}>
            当前 cron: {scanCron}
          </div>
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
          <div className="project-meta" style={{ marginTop: 6 }}>
            请求间隔约 {Math.ceil(60000 / llmRequestsPerMinute)}ms；当前服务商限制是 10 次/分钟
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 24 }}>
        <h2 style={{ marginBottom: 16 }}>EverOS 记忆配置</h2>
        <div className="project-meta" style={{ marginBottom: 16 }}>
          留空表示继承上方 Agent 通用配置。如需单独指定 embedding / rerank / multimodal，请填写对应字段。
        </div>

        <EverosFieldGroup
          title="LLM（用于边界检测与 rerank）"
          model={everos.llmModel ?? ''}
          apiKey={everos.llmApiKey ?? ''}
          baseUrl={everos.llmBaseUrl ?? ''}
          modelPlaceholder={`继承: ${model || '未设置'}`}
          apiKeyPlaceholder="继承 Agent API Key"
          baseUrlPlaceholder={`继承: ${apiUrl || '未设置'}`}
          onModelChange={(value) => updateEveros({ llmModel: value })}
          onApiKeyChange={(value) => updateEveros({ llmApiKey: value })}
          onBaseUrlChange={(value) => updateEveros({ llmBaseUrl: value })}
        />

        <EverosFieldGroup
          title="Embedding"
          model={everos.embeddingModel ?? ''}
          apiKey={everos.embeddingApiKey ?? ''}
          baseUrl={everos.embeddingBaseUrl ?? ''}
          modelPlaceholder="例如 text-embedding-3-small"
          apiKeyPlaceholder="继承 Agent API Key"
          baseUrlPlaceholder={`继承: ${apiUrl || '未设置'}`}
          onModelChange={(value) => updateEveros({ embeddingModel: value })}
          onApiKeyChange={(value) => updateEveros({ embeddingApiKey: value })}
          onBaseUrlChange={(value) => updateEveros({ embeddingBaseUrl: value })}
        />

        <EverosFieldGroup
          title="Multimodal（解析图片 / PDF / 音频）"
          model={everos.multimodalModel ?? ''}
          apiKey={everos.multimodalApiKey ?? ''}
          baseUrl={everos.multimodalBaseUrl ?? ''}
          modelPlaceholder="例如 google/gemini-3-flash-preview"
          apiKeyPlaceholder="继承 Agent API Key"
          baseUrlPlaceholder={`继承: ${apiUrl || '未设置'}`}
          onModelChange={(value) => updateEveros({ multimodalModel: value })}
          onApiKeyChange={(value) => updateEveros({ multimodalApiKey: value })}
          onBaseUrlChange={(value) => updateEveros({ multimodalBaseUrl: value })}
        />

        <EverosFieldGroup
          title="Rerank（agent 搜索排序）"
          model={everos.rerankModel ?? ''}
          apiKey={everos.rerankApiKey ?? ''}
          baseUrl={everos.rerankBaseUrl ?? ''}
          modelPlaceholder="例如 Qwen/Qwen3-Reranker-4B"
          apiKeyPlaceholder="继承 Agent API Key"
          baseUrlPlaceholder={`继承: ${apiUrl || '未设置'}`}
          onModelChange={(value) => updateEveros({ rerankModel: value })}
          onApiKeyChange={(value) => updateEveros({ rerankApiKey: value })}
          onBaseUrlChange={(value) => updateEveros({ rerankBaseUrl: value })}
        />
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={save}>保存</button>
        {saved && <span className="badge badge-success">已保存</span>}
      </div>
    </div>
  );
}
