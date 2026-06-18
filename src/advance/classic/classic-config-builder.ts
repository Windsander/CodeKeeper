import type { Project } from '../types.js';

/**
 * MR Agent 子进程所需的环境变量接口
 *
 * 由 ClassicService 通过 buildMrAgentEnv 构造后传入子进程，
 * mr-agent-entry.ts 中的 loadConfigFromEnv 负责解析。
 */
export interface MrAgentEnv {
  /** LLM API Key */
  CK_LLM_API_KEY: string;
  /** LLM 提供商 */
  CK_LLM_PROVIDER: string;
  /** LLM 模型名 */
  CK_LLM_MODEL: string;
  /** LLM API 基础 URL */
  CK_LLM_API_URL: string;
  /** 额外请求头（JSON 字符串） */
  CK_LLM_HEADERS: string;
  /** 启用 MR 评审的项目列表（JSON 字符串） */
  CK_PROJECTS_JSON: string;
}

/**
 * 将 advance 的 daemon 配置和项目列表转换为 MR Agent 环境变量
 *
 * 只保留同时满足以下条件的项目：
 * 1. 启用了 MR 评审（mrReview.enabled === true）
 * 2. 配置了 GitLab（gitlab 字段存在）
 *
 * 过滤后的项目列表以 JSON 字符串形式写入 CK_PROJECTS_JSON，
 * 子进程反序列化后可直接使用。
 */
export function buildMrAgentEnv(
  projects: Project[],
  daemonConfig: {
    apiKey: string;
    provider: string;
    model: string;
    apiUrl: string;
    headers: string;
  }
): MrAgentEnv {
  const mrProjects = projects.filter((p) => p.mrReview?.enabled && p.gitlab);
  return {
    CK_LLM_API_KEY: daemonConfig.apiKey,
    CK_LLM_PROVIDER: daemonConfig.provider,
    CK_LLM_MODEL: daemonConfig.model,
    CK_LLM_API_URL: daemonConfig.apiUrl,
    CK_LLM_HEADERS: daemonConfig.headers,
    CK_PROJECTS_JSON: JSON.stringify(mrProjects),
  };
}
