import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Theme = 'light' | 'dark';

const FILENAME = 'theme.json';

function getThemeFilePath(): string {
  return join(app.getPath('userData'), FILENAME);
}

/**
 * 从 userData/theme.json 读取主题，失败时返回默认暗色。
 */
export function loadTheme(): Theme {
  try {
    const raw = readFileSync(getThemeFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return parsed.theme === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * 将主题写入 userData/theme.json，失败时仅 warn。
 */
export function saveTheme(theme: Theme): void {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    writeFileSync(getThemeFilePath(), JSON.stringify({ theme }, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.warn('保存主题配置失败', err);
  }
}
