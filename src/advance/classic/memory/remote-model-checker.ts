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

const KNOWN_ENDPOINT_SUFFIXES = ['/models', '/chat/completions'];

function cleanBaseUrl(url: string): string {
  let cleaned = url.trim();
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  for (const suffix of KNOWN_ENDPOINT_SUFFIXES) {
    if (cleaned.toLowerCase().endsWith(suffix.toLowerCase())) {
      cleaned = cleaned.slice(0, -suffix.length);
      break;
    }
  }
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

function normalizeBaseUrl(provider: 'anthropic' | 'openai', apiUrl?: string): string {
  if (!apiUrl) {
    return DEFAULT_BASE_URL[provider];
  }
  const url = cleanBaseUrl(apiUrl);
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

async function probeBaseUrl(baseUrl: string, headers: Record<string, string>): Promise<void> {
  // 先尝试 HEAD，不下载响应体；若服务端不支持 HEAD（405），再降级为 GET
  let res = await fetch(baseUrl, { method: 'HEAD', headers });
  if (res.status === 405) {
    res = await fetch(baseUrl, { method: 'GET', headers });
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`认证失败 HTTP ${res.status}`);
  }
  if (res.status >= 500) {
    throw new Error(`服务端错误 HTTP ${res.status}`);
  }
  // 其他 2xx/3xx/4xx（除 401/403/5xx 外）均视为基地址可达
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
 * 优先调用 `GET /v1/models` 验证模型是否存在；若该接口不可用，则降级为
 * HEAD/GET 基地址探测，整个过程不消耗 token。
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
      if (!found) {
        logger.debug({ baseUrl, fullModel, returnedIds: ids.slice(0, 20) }, '远端模型 /v1/models 返回列表未包含配置模型，但服务可达');
      }
      // 只要 /v1/models 能通即认为服务可用；模型名可能是别名或自定义，不强求在列表中精确匹配
      return {
        state: 'running',
        modelLabel: formatModelShortName(fullModel),
        fullModel,
        baseUrl,
        error: null,
        lastCheckedAt: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/HTTP (\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      // /v1/models 不存在时（400/404/405），降级为探测基地址是否可达，不消耗 token
      if (status === 400 || status === 404 || status === 405) {
        try {
          await probeBaseUrl(baseUrl, getHeaders(params));
          return {
            state: 'running',
            modelLabel: formatModelShortName(fullModel),
            fullModel,
            baseUrl,
            error: null,
            lastCheckedAt: Date.now(),
          };
        } catch (probeErr) {
          const probeMessage = probeErr instanceof Error ? probeErr.message : String(probeErr);
          return {
            state: 'error',
            modelLabel: formatModelShortName(fullModel),
            fullModel,
            baseUrl,
            error: probeMessage,
            lastCheckedAt: Date.now(),
          };
        }
      }
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
