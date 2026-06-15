import os from 'os';
import path from 'path';

/**
 * Get the user's home directory in a cross-platform way
 */
export function getHomeDir(): string {
  return os.homedir();
}

/**
 * Get the default config directory for CodeKeeper
 */
export function getConfigDir(): string {
  return path.join(getHomeDir(), '.codekeeper');
}

/**
 * Get the default log directory for CodeKeeper
 */
export function getLogDir(): string {
  return path.join(getHomeDir(), 'Logs', 'codekeeper');
}

/**
 * Get the default workspace directory for project clones/checkouts
 */
export function getWorkspaceDir(): string {
  return path.join(getHomeDir(), 'codekeeper-workspace');
}
