import { createRoleRunner } from '../runners/role-runner.js';
import type { Role } from '../../types.js';
import { LlmClient } from '../../llm/client.js';

/**
 * 从环境变量解析 Runner 配置
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): {
  llm: {
    apiKey: string;
    provider: string;
    model: string;
    apiUrl: string;
    headers: string;
  };
  projects: unknown[];
} {
  const apiKey = env.CK_LLM_API_KEY;
  const provider = env.CK_LLM_PROVIDER;
  const model = env.CK_LLM_MODEL;
  const apiUrl = env.CK_LLM_API_URL;
  const headers = env.CK_LLM_HEADERS ?? '{}';
  const projectsJson = env.CK_PROJECTS_JSON;

  if (!apiKey || !provider || !model || !apiUrl) {
    throw new Error(
      '[Role Agent] 缺少必要的环境变量：CK_LLM_API_KEY, CK_LLM_PROVIDER, CK_LLM_MODEL, CK_LLM_API_URL'
    );
  }

  let projects: unknown[] = [];
  if (projectsJson) {
    try {
      projects = JSON.parse(projectsJson) as unknown[];
    } catch {
      throw new Error('[Role Agent] CK_PROJECTS_JSON 解析失败，内容不是有效的 JSON');
    }
  }

  return {
    llm: { apiKey, provider, model, apiUrl, headers },
    projects,
  };
}

/**
 * 统一角色 Agent Entry
 * 根据 ROLE 环境变量选择对应的 Runner 并启动项目循环
 */
async function main() {
  const role = process.env.ROLE as Role;
  if (!role) {
    throw new Error('缺少 ROLE 环境变量');
  }

  const config = loadConfigFromEnv(process.env);

  if (config.projects.length === 0) {
    console.log('[Role Agent] 没有需要处理的项目，退出');
    return;
  }

  // 解析额外请求头
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(config.llm.headers) as Record<string, string>;
  } catch {
    console.warn('[Role Agent] CK_LLM_HEADERS 解析失败，使用空对象');
  }

  const llmClient = new LlmClient({
    apiKey: config.llm.apiKey,
    provider: config.llm.provider as 'anthropic' | 'openai',
    model: config.llm.model,
    baseURL: config.llm.apiUrl,
    headers,
    maxTokens: 4096,
  });

  const runner = createRoleRunner(role, llmClient);

  for (const project of config.projects) {
    await runner.startProjectLoop(project as { id: string; rootPath: string; name: string });
  }

  // 子进程需要保持事件循环活跃以运行 cron 定时器
  console.log(`[Role Agent] 已为 ${config.projects.length} 个项目启动 ${role} 角色循环，子进程保持运行`);
}

// 仅当直接运行时执行主函数（子进程入口）
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('role-entry.ts') ||
  process.argv[1].endsWith('role-entry.js')
);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
