import type { EverOSConfig } from '../../config/daemon-config.js';
import type { RemoteModelItemStatus } from '../../../electron/shared/service-status.js';
import { formatModelShortName } from '../../../electron/shared/model-label.js';

interface LlmConfig {
  apiKey?: string;
  apiUrl?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
}

const DEFAULT_BASE_URL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

function getHeaders(config: LlmConfig): Record<string, string> {
  if (!config.apiKey) return {};
  if (config.provider === 'anthropic') {
    return { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${config.apiKey}` };
}

async function listModels(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
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
    });
  }

  async checkMultimodal(config: EverOSConfig): Promise<RemoteModelItemStatus> {
    return this.check({
      apiKey: config.multimodalApiKey,
      apiUrl: config.multimodalBaseUrl,
      provider: config.multimodalProvider ?? 'anthropic',
      model: config.multimodalModel,
    });
  }

  private async check(params: {
    apiKey?: string;
    apiUrl?: string;
    provider: 'anthropic' | 'openai';
    model?: string;
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

    const baseUrl = params.apiUrl || DEFAULT_BASE_URL[params.provider];
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
