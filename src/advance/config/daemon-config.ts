import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * EverOS 独立配置
 *
 * 留空字段表示“继承 Agent 通用配置”或“使用 EverOS 默认值”。
 */
export interface EverOSConfig {
  /** LLM 模型（OpenAI 协议） */
  llmModel?: string;
  /** LLM API Key */
  llmApiKey?: string;
  /** LLM Base URL */
  llmBaseUrl?: string;

  /** Embedding 模型 */
  embeddingModel?: string;
  /** Embedding API Key */
  embeddingApiKey?: string;
  /** Embedding Base URL */
  embeddingBaseUrl?: string;

  /** 多模态 LLM 模型（解析图片 / PDF / 音频） */
  multimodalModel?: string;
  /** 多模态 LLM API Key */
  multimodalApiKey?: string;
  /** 多模态 LLM Base URL */
  multimodalBaseUrl?: string;

  /** Rerank 模型 */
  rerankModel?: string;
  /** Rerank API Key */
  rerankApiKey?: string;
  /** Rerank Base URL */
  rerankBaseUrl?: string;
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
  if (merged.everos) {
    (Object.keys(merged.everos) as Array<keyof EverOSConfig>).forEach((key) => {
      if (merged.everos![key] === undefined) {
        delete merged.everos![key];
      }
    });
    if (Object.keys(merged.everos).length === 0) {
      delete merged.everos;
    }
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
