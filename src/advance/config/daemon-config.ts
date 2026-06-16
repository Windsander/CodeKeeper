import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DaemonPersistedConfig {
  apiUrl?: string;
  provider?: 'anthropic' | 'openai';
  model?: string;
  headers?: Record<string, string>;
  scanCron?: string;
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
  // 删除 undefined 字段
  (Object.keys(merged) as Array<keyof DaemonPersistedConfig>).forEach((key) => {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
