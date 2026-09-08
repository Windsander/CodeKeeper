import { createRoleRunner } from '../runners/role-runner.js';
import type { Role, Project } from '../../types.js';
import { LlmClient } from '../../llm/client.js';
import { MetadataStore } from '../../store/metadata-store.js';
import { PipelineExecutor } from '../../pipeline/core/executor.js';
import { PipelineRunStore } from '../../pipeline/core/run-store.js';
import type { PipelineDefinitionWithSubgraph } from '../../pipeline/core/types.js';
import { loadProjectPipeline } from '../../pipeline/default-pipeline.js';
import { createRoleStageHandlers } from '../stage-handlers.js';

/** 项目管线中正本中本角色节点的子图（无子图返回 null，保持黑箱执行） */
function loadRoleSubgraph(project: Project, role: Role): PipelineDefinitionWithSubgraph | null {
  const definition = loadProjectPipeline(project);
  if (!definition) return null;
  const roleNode = definition.nodes.find(node => node.type === `role.${role}`);
  return (roleNode?.subgraph as PipelineDefinitionWithSubgraph | undefined) ?? null;
}

/**
 * 从环境变量解析 Agent 配置
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): {
  role: Role;
  projectId: string;
  dbPath: string;
  llm: {
    apiKey: string;
    provider: string;
    model: string;
    apiUrl: string;
    headers: string;
    rpm: number;
  };
} {
  const role = env.ROLE as Role;
  const projectId = env.CK_PROJECT_ID ?? '';
  const dbPath = env.CK_DB_PATH ?? '';
  const apiKey = env.CK_LLM_API_KEY ?? '';
  const provider = env.CK_LLM_PROVIDER ?? '';
  const model = env.CK_LLM_MODEL ?? '';
  const apiUrl = env.CK_LLM_API_URL ?? '';
  const headers = env.CK_LLM_HEADERS ?? '{}';
  const rpm = Number(env.CK_LLM_RPM ?? '10');

  if (!role) {
    throw new Error('缺少 ROLE 环境变量');
  }
  if (!projectId) {
    throw new Error('缺少 CK_PROJECT_ID 环境变量');
  }
  if (!dbPath) {
    throw new Error('缺少 CK_DB_PATH 环境变量');
  }
  if (!apiKey || !provider || !model || !apiUrl) {
    throw new Error(
      '缺少必要的环境变量：CK_LLM_API_KEY, CK_LLM_PROVIDER, CK_LLM_MODEL, CK_LLM_API_URL'
    );
  }

  return {
    role,
    projectId,
    dbPath,
    llm: { apiKey, provider, model, apiUrl, headers, rpm },
  };
}

/**
 * 根据每分钟请求数计算最小请求间隔（毫秒）
 */
function computeMinRequestInterval(rpm: number): number {
  if (rpm <= 0) return 6000;
  return Math.ceil(60000 / rpm);
}

/**
 * Role 节点实例入口（子进程）。
 *
 * 一个进程只服务一个 (项目, 角色) 节点实例：启动时加载项目并构造 Runner，
 * 之后等待父进程（RoleNodeRuntime）经 IPC 下发的 run 指令执行单次循环。
 * 调度由 daemon 侧 PipelineScheduler（trigger.cron 节点）负责，本进程不再自持 cron。
 */
async function main() {
  const config = loadConfigFromEnv(process.env);
  console.log(`[Role Node] 启动，ROLE=${config.role}，项目=${config.projectId}`);

  // 解析额外请求头（空字符串按空对象处理）
  let headers: Record<string, string> = {};
  if (config.llm.headers.trim()) {
    try {
      headers = JSON.parse(config.llm.headers) as Record<string, string>;
    } catch {
      console.warn('[Role Node] CK_LLM_HEADERS 解析失败，使用空对象');
    }
  }

  const minRequestInterval = computeMinRequestInterval(config.llm.rpm);

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

  const store = new MetadataStore(config.dbPath);
  const project = store.getProject(config.projectId);
  if (!project) {
    throw new Error(`[Role Node] 项目不存在: ${config.projectId}`);
  }

  // 钻取层：项目的管线正本中，本角色节点若带 subgraph，则执行子图而非整轮黑箱
  const roleSubgraph = loadRoleSubgraph(project, config.role);
  const stageHandlers = roleSubgraph ? createRoleStageHandlers({ project, runner }) : null;
  // 子图执行落库（stage 记录按子图节点命名，画布运行状态叠加可查）
  const subgraphExecutor = stageHandlers
    ? new PipelineExecutor(stageHandlers, new PipelineRunStore(store.database))
    : null;

  // 指令循环：等待父进程派发 run
  process.on('message', message => {
    if (!isRunMessage(message)) return;
    const work =
      subgraphExecutor && roleSubgraph
        ? subgraphExecutor
            .execute(
              roleSubgraph,
              {
                logger: console,
                services: { project },
                vars: { projectId: project.id },
              },
              { projectId: project.id }
            )
            .then(record => {
              if (record.status !== 'succeeded') {
                throw new Error(record.error ?? '子图执行失败');
              }
            })
        : runner.runProjectOnce(project);
    work
      .then(() => {
        process.send?.({ type: 'done' });
      })
      .catch(error => {
        const text = error instanceof Error ? error.message : String(error);
        console.error(`[Role Node] 单次执行失败: ${text}`);
        process.send?.({ type: 'error', message: text });
      });
  });

  // 就绪信号：父进程据此开始派发
  process.send?.({ type: 'ready' });
  console.log('[Role Node] 已就绪，等待触发指令');

  // 优雅退出
  const cleanup = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

function isRunMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'run'
  );
}

// 仅当直接运行时执行主函数（子进程入口）
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('role-entry.ts') || process.argv[1].endsWith('role-entry.js'));
if (isMainModule) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
