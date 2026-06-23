/**
 * MR Agent 项目级状态持久化
 *
 * 每个项目独立维护自己的状态文件：
 * `<archiveRoot>/mr-agent-project-status.json`
 *
 * 用于记录：
 * - 最近一次错误（类型、消息、时间）
 * - 最近一次成功评审时间
 * - Agent 启动/停止时间
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getArchiveRoot } from '../../types.js';
import type { Project } from '../../types.js';

export type MrAgentProjectErrorType =
  | 'missing-token'
  | 'invalid-token'
  | 'gitlab-api'
  | 'unknown';

export interface MrAgentProjectStatus {
  /** 最近一次错误 */
  lastError?: {
    /** 错误类型 */
    type: MrAgentProjectErrorType;
    /** 错误描述 */
    message: string;
    /** 时间戳 */
    at: number;
  };
  /** 最近一次成功完成评审的时间戳 */
  lastSuccessAt?: number;
  /** 当前 Agent 启动时间戳 */
  agentStartedAt?: number;
  /** 当前 Agent 停止时间戳 */
  agentStoppedAt?: number;
}

function getStatusPath(project: Project): string {
  const archiveRoot = getArchiveRoot(project);
  return join(archiveRoot, 'mr-agent-project-status.json');
}

/**
 * 读取项目 MR Agent 状态
 *
 * 状态文件不存在或解析失败时返回空对象。
 */
export function loadProjectStatus(project: Project): MrAgentProjectStatus {
  const path = getStatusPath(project);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed as MrAgentProjectStatus;
  } catch {
    return {};
  }
}

/**
 * 写入项目 MR Agent 状态
 */
export function saveProjectStatus(
  project: Project,
  status: MrAgentProjectStatus
): void {
  const path = getStatusPath(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2), 'utf-8');
}

/**
 * 根据错误信息判断错误类型
 *
 * - HTTP 401/403 → invalid-token
 * - token 为空已在调用方处理，此处不会命中
 * - 其他 GitLab API 错误 → gitlab-api
 * - 未知错误 → unknown
 */
function classifyError(error: unknown): MrAgentProjectErrorType {
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\b(401|403)\b/);
  if (statusMatch) {
    return 'invalid-token';
  }
  if (message.includes('GitLab API')) {
    return 'gitlab-api';
  }
  return 'unknown';
}

/**
 * 记录项目 MR Agent 错误状态
 *
 * 支持传入 Error 对象自动分类，也可通过 overrideType 显式指定类型。
 */
export function recordProjectError(
  project: Project,
  error: unknown,
  overrideType?: MrAgentProjectErrorType
): void {
  const status = loadProjectStatus(project);
  status.lastError = {
    type: overrideType ?? classifyError(error),
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  };
  saveProjectStatus(project, status);
}

/**
 * 记录项目 Token 缺失错误
 */
export function recordProjectMissingToken(project: Project, message: string): void {
  recordProjectError(project, new Error(message), 'missing-token');
}

/**
 * 清除项目 MR Agent 错误状态并记录成功时间
 */
export function clearProjectError(project: Project): void {
  const status = loadProjectStatus(project);
  delete status.lastError;
  status.lastSuccessAt = Date.now();
  saveProjectStatus(project, status);
}

/**
 * 记录 Agent 启动时间
 */
export function recordAgentStarted(project: Project): void {
  const status = loadProjectStatus(project);
  status.agentStartedAt = Date.now();
  saveProjectStatus(project, status);
}

/**
 * 记录 Agent 停止时间
 */
export function recordAgentStopped(project: Project): void {
  const status = loadProjectStatus(project);
  status.agentStoppedAt = Date.now();
  saveProjectStatus(project, status);
}
