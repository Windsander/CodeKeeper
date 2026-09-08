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

/**
 * 获取 CodeKeeper App 存储空间根目录
 *
 * 用于存放不属于项目仓库、不应被提交的 App 级数据，
 * 例如 memory/souls、mr-agent-status 等。
 */
export function getAppStorageDir(): string {
  return path.join(getHomeDir(), '.codekeeper');
}

/**
 * 获取指定项目的 souls 配置目录
 *
 * 路径：~/.codekeeper/memory/souls/{projectName}/
 */
export function getProjectSoulsDir(projectName: string): string {
  const safeName = projectName.replace(/[\\/:*?"<>|]/g, '_');
  return path.join(getAppStorageDir(), 'memory', 'souls', safeName);
}

/**
 * 获取指定项目的 MR Agent 状态目录
 *
 * 路径：~/.codekeeper/memory/agents/{projectName}/
 */
export function getProjectAgentStatusDir(projectName: string): string {
  const safeName = projectName.replace(/[\\/:*?"<>|]/g, '_');
  return path.join(getAppStorageDir(), 'memory', 'agents', safeName);
}
