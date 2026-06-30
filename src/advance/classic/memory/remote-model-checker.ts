import type { EverOSConfig } from '../../config/daemon-config.js';
import type { RemoteModelItemStatus } from '../../../electron/shared/service-status.js';
import { formatModelShortName } from '../../../electron/shared/model-label.js';
import { logger } from '../../../core/logger.js';

interface LlmConfig {
  apiKey?: string;
  apiUrl?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

const OFFICIAL_HOSTS: Record<'anthropic' | 'openai', string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
};

function getHeaders(config: LlmConfig): Record<string, string> {
  if (!config.apiKey) return config.headers ?? {};
  const auth: Record<string, string> =
    config.provider === 'anthropic'
      ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${config.apiKey}` };
  // 用户自定义 Headers 可覆盖默认 auth，方便代理/网关场景
  return { ...auth, ...(config.headers ?? {}) };
}

function normalizeBaseUrl(provider: 'anthropic' | 'openai', apiUrl?: string): string {
  if (!apiUrl) {
    return DEFAULT_BASE_URL[provider];
  }
  let url = apiUrl.trim();
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  if (url.endsWith('/v1')) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === OFFICIAL_HOSTS[provider] && (parsed.pathname === '' || parsed.pathname === '/')) {
      return `${url}/v1`;
    }
  } catch {
    // 非法 URL 保持原样，让后续请求报错
  }
  return url;
}

async function listModels(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // 忽略读取 body 失败
    }
    const preview = body.length > 200 ? `${body.slice(0, 200)}...` : body;
    logger.warn({ status: res.status, baseUrl, body: preview }, '远端模型 /v1/models 检测失败');
    throw new Error(`HTTP ${res.status}: ${preview || '无响应体'}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
}

/**
 * 远端模型连通性检测器。
 *
 * 仅调用各厂商的 `GET /v1/models` 接口列出可用模型，不消耗 token。
 */
export class RemoteModelChecker {
  async checkLlm(config: LlmConfig): Promise<RemoteModelItemStatus> {
    return this.check({
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      provider: config.provider ?? 'anthropic',
      model: config.model,
      headers: config.headers,
    });
  }

  async checkMultimodal(config: EverOSConfig): Promise<RemoteModelItemStatus> {
    let headers: Record<string, string> | undefined;
    if (config.multimodalHeaders) {
      try {
        headers = JSON.parse(config.multimodalHeaders) as Record<string, string>;
      } catch {
        headers = undefined;
      }
    }
    return this.check({
      apiKey: config.multimodalApiKey,
      apiUrl: config.multimodalBaseUrl,
      provider: config.multimodalProvider ?? 'anthropic',
      model: config.multimodalModel,
      headers,
    });
  }

  private async check(params: {
    apiKey?: string;
    apiUrl?: string;
    provider: 'anthropic' | 'openai';
    model?: string;
    headers?: Record<string, string>;
  }): Promise<RemoteModelItemStatus> {
    const fullModel = params.model ?? '';
    if (!params.apiKey || !fullModel) {
      return {
        state: 'unconfigured',
        modelLabel: formatModelShortName(fullModel),
        fullModel,
        baseUrl: params.apiUrl ?? null,
        error: null,
        lastCheckedAt: Date.now(),
      };
    }

    const baseUrl = normalizeBaseUrl(params.provider, params.apiUrl);
    try {
      const ids = await listModels(baseUrl, getHeaders(params));
      const found = ids.includes(fullModel);
      return {
        state: found ? 'running' : 'error',
        modelLabel: formatModelShortName(fullModel),
        fullModel,
        baseUrl,
        error: found ? null : '服务端未返回配置的模型',
        lastCheckedAt: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        state: 'error',
        modelLabel: formatModelShortName(fullModel),
        fullModel,
        baseUrl,
        error: message,
        lastCheckedAt: Date.now(),
      };
    }
  }
}
