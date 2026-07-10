import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * EverOS 多模态模型覆盖配置。
 *
 * 所有字段留空表示不向 EverOS 传入多模态覆盖，使用 EverOS 自身默认值。
 */
export interface EverOSConfig {
  /** 多模态 LLM 服务提供商 */
  multimodalProvider?: 'anthropic' | 'openai';
  /** 多模态 LLM API Key */
  multimodalApiKey?: string;
  /** 多模态 LLM Base URL */
  multimodalBaseUrl?: string;
  /** 多模态 LLM 模型（解析图片 / PDF / 音频） */
  multimodalModel?: string;
  /** 多模态 LLM 自定义 Headers（JSON 字符串） */
  multimodalHeaders?: string;
}

export interface DaemonPersistedConfig {
  apiKey?: string;
  apiUrl?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  headers?: Record<string, string>;
  scanCron?: string;
  /** 每分钟 LLM 请求数限制，默认 10 */
  llmRequestsPerMinute?: number;
  /** 本地 Embedding 模型名 */
  embeddingModel?: string;
  /** 本地 Rerank 模型名 */
  rerankModel?: string;
  /** EverOS 独立配置；未配置时继承 Agent 通用配置 */
  everos?: EverOSConfig;
}

const CONFIG_DIR = join(homedir(), '.codekeeper-advance');
const CONFIG_PATH = join(CONFIG_DIR, 'daemon-config.json');

export function loadDaemonConfig(): DaemonPersistedConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as DaemonPersistedConfig;
  } catch {
    return {};
  }
}

export function saveDaemonConfig(config: DaemonPersistedConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = loadDaemonConfig();
  const merged: DaemonPersistedConfig = {
    ...existing,
    ...config,
  };
  // 深度合并 everos 配置，避免整个对象被覆盖
  if (existing.everos && config.everos) {
    merged.everos = { ...existing.everos, ...config.everos };
  }
  // 删除 undefined 字段
  (Object.keys(merged) as Array<keyof DaemonPersistedConfig>).forEach((key) => {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  });
  const everosConfig = merged.everos;
  if (everosConfig) {
    (Object.keys(everosConfig) as Array<keyof EverOSConfig>).forEach((key) => {
      if (everosConfig[key] === undefined) {
        delete everosConfig[key];
      }
    });
    if (Object.keys(everosConfig).length === 0) {
      delete merged.everos;
    }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
