import { createRoleRunner } from '../runners/role-runner.js';
import type { Role, Project } from '../../types.js';
import { LlmClient } from '../../llm/client.js';
import { MetadataStore } from '../../store/metadata-store.js';

/**
 * 从环境变量解析 Agent 配置
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): {
  role: Role;
  dbPath: string;
  llm: {
    apiKey: string;
    provider: string;
    model: string;
    apiUrl: string;
    headers: string;
    rpm: number;
  };
  projects: Project[];
} {
  const role = env.ROLE as Role;
  const dbPath = env.CK_DB_PATH ?? '';
  const apiKey = env.CK_LLM_API_KEY ?? '';
  const provider = env.CK_LLM_PROVIDER ?? '';
  const model = env.CK_LLM_MODEL ?? '';
  const apiUrl = env.CK_LLM_API_URL ?? '';
  const headers = env.CK_LLM_HEADERS ?? '{}';
  const rpm = Number(env.CK_LLM_RPM ?? '10');
  const projects = parseProjectsJson(env.CK_PROJECTS_JSON);

  if (!apiKey || !provider || !model || !apiUrl) {
    throw new Error('缺少必要的环境变量');
  }

  return {
    role,
    dbPath,
    llm: { apiKey, provider, model, apiUrl, headers, rpm },
    projects,
  };
}

function parseProjectsJson(raw?: string): Project[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Project[];
  } catch {
    throw new Error('CK_PROJECTS_JSON 解析失败');
  }
}

/**
 * 根据每分钟请求数计算最小请求间隔（毫秒）
 */
function computeMinRequestInterval(rpm: number): number {
  if (rpm <= 0) return 6000;
  return Math.ceil(60000 / rpm);
}

/**
 * 统一角色 Agent Entry
 * 作为独立子进程运行，周期性读取数据库中该角色的启用项目，
 * 动态启动/停止对应项目的 Agent 循环。
 */
async function main() {
  const config = loadConfigFromEnv(process.env);

  console.log(`[Role Agent] 启动，ROLE=${config.role}`);
  if (!config.role) {
    throw new Error('缺少 ROLE 环境变量');
  }
  if (!config.dbPath) {
    throw new Error('缺少 CK_DB_PATH 环境变量');
  }

  console.log(`[Role Agent] 数据库路径: ${config.dbPath}`);
  console.log(
    `[Role Agent] LLM 配置检查: provider=${config.llm.provider ? '有' : '无'}, model=${config.llm.model ? '有' : '无'}, apiUrl=${config.llm.apiUrl ? '有' : '无'}, apiKey=${config.llm.apiKey ? '有' : '无'}, rpm=${config.llm.rpm}`
  );
  if (!config.llm.apiKey || !config.llm.provider || !config.llm.model || !config.llm.apiUrl) {
    throw new Error(
      '[Role Agent] 缺少必要的环境变量：CK_LLM_API_KEY, CK_LLM_PROVIDER, CK_LLM_MODEL, CK_LLM_API_URL'
    );
  }

  // 解析额外请求头（空字符串按空对象处理）
  let headers: Record<string, string> = {};
  if (config.llm.headers.trim()) {
    try {
      headers = JSON.parse(config.llm.headers) as Record<string, string>;
    } catch {
      console.warn('[Role Agent] CK_LLM_HEADERS 解析失败，使用空对象');
    }
  }

  const minRequestInterval = computeMinRequestInterval(config.llm.rpm);
  console.log(`[Role Agent] LLM 最小请求间隔: ${minRequestInterval}ms`);

  const llmClient = new LlmClient({
    apiKey: config.llm.apiKey,
    provider: config.llm.provider as 'anthropic' | 'openai',
    model: config.llm.model,
    baseURL: config.llm.apiUrl,
    headers,
    maxTokens: 4096,
    minRequestInterval,
  });

  const runner = createRoleRunner(config.role, {
    llmClient,
    mcpUrl: process.env.CK_EVEROS_MCP_URL,
    codeGraphUrl: process.env.CK_CODEGRAPH_SERVER_URL,
  });

  // 子进程独立打开数据库，周期性读取启用项目并同步 Agent 循环
  const store = new MetadataStore(config.dbPath);

  const activeProjects = new Map<
    string,
    { project: { id: string; rootPath: string; name: string } }
  >();

  let syncing = false;

  const syncProjects = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const enabledProjects = store.getRoleEnabledProjects(config.role);
      const enabledIds = new Set(enabledProjects.map((p) => p.id));

      // 停止已禁用或已移除的项目
      for (const [projectId, entry] of activeProjects) {
        if (!enabledIds.has(projectId)) {
          console.log(`[Role Agent] 项目 ${entry.project.name} 已禁用，停止循环`);
          runner.stopProjectLoop(projectId);
          activeProjects.delete(projectId);
        }
      }

      // 启动新启用的项目
      for (const project of enabledProjects) {
        if (!activeProjects.has(project.id)) {
          console.log(`[Role Agent] 项目 ${project.name} 已启用，启动循环`);
          activeProjects.set(project.id, { project });
          // 异步启动，避免阻塞本次同步
          runner.startProjectLoop(project).catch((err) => {
            console.error(`[Role Agent] 项目 ${project.name} 启动循环失败:`, err);
            activeProjects.delete(project.id);
          });
        }
      }
    } catch (err) {
      console.error('[Role Agent] 同步启用项目失败:', err);
    } finally {
      syncing = false;
    }
  };

  // 立即同步一次，然后每 10 秒轮询
  await syncProjects();
  const intervalId = setInterval(() => {
    void syncProjects();
  }, 10000);

  console.log('[Role Agent] 监控服务已启动，每 10 秒检查一次项目启用状态');

  // 优雅退出：收到信号后停止所有循环并关闭数据库
  const cleanup = () => {
    console.log('[Role Agent] 收到退出信号，停止监控');
    clearInterval(intervalId);
    for (const [projectId] of activeProjects) {
      runner.stopProjectLoop(projectId);
    }
    activeProjects.clear();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// 仅当直接运行时执行主函数（子进程入口）
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('role-entry.ts') || process.argv[1].endsWith('role-entry.js'));
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
