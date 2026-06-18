/**
 * MR Agent 子进程入口
 *
 * 作为独立子进程启动，从环境变量读取 advance 的 LLM 配置和项目配置，
 * 轮询评审所有启用 MR 评审的 open MRs。
 *
 * 目前只做单次评审轮询，后续由 ClassicService 定时 spawn 该进程。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LlmClient } from '../llm/client.js';
import { GitLabProvider } from './provider/gitlab-provider.js';
import { ClassicReviewer } from './review/reviewer.js';
import { buildDiffPosition, getFindingKey } from './provider/discussion-mapper.js';
import { WorktreeManager } from './worktree/worktree-manager.js';
import { MrFixAgent } from './fix/mr-fix-agent.js';
import { FixDecisionEngine } from './fix/fix-decision-engine.js';
import { loadSoulContent } from './soul/soul-loader.js';
import { loadProjectContext } from './context/project-context-loader.js';
import type { Project, GitlabConfig, MrReviewConfig } from '../types.js';
import { getArchiveRoot } from '../types.js';
import type {
  MergeRequest,
  ReviewResult,
  ReviewFinding,
  MrDiff,
} from './provider/types.js';

/**
 * 从环境变量解析 MR Agent 配置
 *
 * 导出供测试使用，确保解析逻辑可独立验证。
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): {
  llm: {
    apiKey: string;
    provider: string;
    model: string;
    apiUrl: string;
    headers: string;
  };
  projects: Project[];
} {
  const apiKey = env.CK_LLM_API_KEY;
  const provider = env.CK_LLM_PROVIDER;
  const model = env.CK_LLM_MODEL;
  const apiUrl = env.CK_LLM_API_URL;
  const headers = env.CK_LLM_HEADERS ?? '{}';
  const projectsJson = env.CK_PROJECTS_JSON;

  if (!apiKey || !provider || !model || !apiUrl) {
    throw new Error(
      '[MR Agent] 缺少必要的环境变量：CK_LLM_API_KEY, CK_LLM_PROVIDER, CK_LLM_MODEL, CK_LLM_API_URL'
    );
  }

  let projects: Project[] = [];
  if (projectsJson) {
    try {
      projects = JSON.parse(projectsJson) as Project[];
    } catch {
      throw new Error('[MR Agent] CK_PROJECTS_JSON 解析失败，内容不是有效的 JSON');
    }
  }

  return {
    llm: { apiKey, provider, model, apiUrl, headers },
    projects,
  };
}

/**
 * Severity 到图标和颜色标签的映射
 */
const SEVERITY_META: Record<
  ReviewFinding['severity'],
  { icon: string; label: string; color: string }
> = {
  CRITICAL: { icon: '🚨', label: '严重', color: '#dc2626' },
  HIGH: { icon: '🔴', label: '高', color: '#ea580c' },
  MEDIUM: { icon: '🟠', label: '中', color: '#d97706' },
  LOW: { icon: '🟡', label: '低', color: '#ca8a04' },
};

/**
 * 按 severity 对 findings 分组
 */
function groupFindingsBySeverity(
  findings: ReviewFinding[]
): Record<ReviewFinding['severity'], ReviewFinding[]> {
  const groups: Record<ReviewFinding['severity'], ReviewFinding[]> = {
    CRITICAL: [],
    HIGH: [],
    MEDIUM: [],
    LOW: [],
  };
  for (const f of findings) {
    groups[f.severity].push(f);
  }
  return groups;
}

/**
 * 把 LLM 生成的总结文本格式化为 Markdown 引用块行
 *
 * 例如将 "存在两处改进点：1) ... 2) ..." 转换为真正的列表，增强可读性。
 */
function formatSummary(summary: string): string[] {
  let formatted = summary.replace(/(\d+)\)\s*/g, '$1. ');
  formatted = formatted.replace(/([^\n])(\d+\.\s)/g, '$1\n$2');
  return formatted.split('\n').map((line) => `> ${line}`);
}

/**
 * 生成单条 finding 的 discussion body
 */
function formatFindingDiscussionBody(finding: ReviewFinding): string {
  const meta = SEVERITY_META[finding.severity];
  const ruleTag = finding.ruleId ? ` · 规则 \`${finding.ruleId}\`` : '';
  return [
    `## ${meta.icon} ${meta.label}${ruleTag}`,
    ``,
    `**问题描述：**`,
    finding.message,
    ``,
    `**修改建议：**`,
    finding.suggestion,
  ].join('\n');
}

/**
 * 为指定 MR 生成 summary 评论正文
 *
 * 仅用于 reviewer / reviewer+auto-fixer 角色，汇总所有 findings。
 */
export function formatReviewComment(mr: MergeRequest, result: ReviewResult): string {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const severityOrder: ReviewFinding['severity'][] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const groups = groupFindingsBySeverity(result.findings);
  const total = result.findings.length;

  const lines: string[] = [
    `## 🤖 CodeKeeper 自动评审`,
    ``,
    `**MR**: ${mr.title}<br>`,
    `**分支**: \`${mr.sourceBranch}\` → \`${mr.targetBranch}\`<br>`,
    `**发现项**: ${total > 0 ? `${total} 个` : '✅ 无'}`,
    ``,
    ...formatSummary(result.summary),
    ``,
  ];

  if (total > 0) {
    lines.push(`### ⚠️ 发现项`, ``);
    for (const severity of severityOrder) {
      const items = groups[severity];
      if (items.length === 0) continue;
      const meta = SEVERITY_META[severity];
      lines.push(`- ${meta.icon} **${meta.label}** (${items.length})`);
      for (const finding of items) {
        const ruleTag = finding.ruleId ? ` · 规则 \`${finding.ruleId}\`` : '';
        lines.push(
          `  - \`${finding.file}:${finding.line}\`${ruleTag} ${finding.message}<br>**建议**：${finding.suggestion}`
        );
      }
      lines.push(``);
    }
  }

  lines.push(`---`, ``, `*生成于 ${now} · CodeKeeper Advance MR 评审 Agent*`);

  return lines.join('\n');
}

/**
 * 已发布 discussion 的记录项
 */
interface PostedDiscussion {
  findingKey: string;
  discussionId: string;
  file: string;
  line: number;
  severity: ReviewFinding['severity'];
  resolved: boolean;
}

/**
 * MR Agent 状态文件结构
 */
interface MrAgentState {
  version: number;
  discussions: Record<string, PostedDiscussion[]>;
}

function getStatePath(project: Project): string {
  const archiveRoot = getArchiveRoot(project);
  return join(archiveRoot, 'mr-agent-state.json');
}

function loadState(project: Project): MrAgentState {
  const path = getStatePath(project);
  if (!existsSync(path)) {
    return { version: 1, discussions: {} };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as MrAgentState;
    if (!parsed || typeof parsed !== 'object' || !parsed.discussions) {
      return { version: 1, discussions: {} };
    }
    return parsed;
  } catch {
    return { version: 1, discussions: {} };
  }
}

function saveState(project: Project, state: MrAgentState): void {
  const path = getStatePath(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

function getDiscussionStateKey(mr: MergeRequest): string {
  return `${mr.sourceBranch}:${mr.targetBranch}`;
}

/**
 * 从 discussion body 中尝试推断 finding 信息
 *
 * 解析规则：
 * - 文件路径与行号：匹配 `\`path/to/file.ts:123\``
 * - severity：根据 body 中的 emoji 或关键字推断
 * - message / suggestion：从 "问题描述" 和 "修改建议" 段提取
 *
 * 解析失败返回 null。
 */
function inferFindingFromDiscussion(body: string): Omit<ReviewFinding, 'autoFixable'> | null {
  const fileLineMatch = body.match(/`([^`]+):(\d+)`/);
  if (!fileLineMatch) return null;
  const file = fileLineMatch[1];
  const line = Number(fileLineMatch[2]);

  let severity: ReviewFinding['severity'] = 'MEDIUM';
  if (body.includes('🚨') || body.includes('严重')) severity = 'CRITICAL';
  else if (body.includes('🔴') || body.includes('高')) severity = 'HIGH';
  else if (body.includes('🟡') || body.includes('低')) severity = 'LOW';

  const ruleIdMatch = body.match(/规则\s*`([^`]+)`/);
  const ruleId = ruleIdMatch ? ruleIdMatch[1] : undefined;

  const messageMatch = body.match(/\*\*问题描述：\*\*\s*([\s\S]*?)(?=\*\*修改建议|\*\*|$)/);
  const suggestionMatch = body.match(/\*\*修改建议：\*\*\s*([\s\S]*?)$/);

  const message = messageMatch ? messageMatch[1].trim() : '未明确描述的问题';
  const suggestion = suggestionMatch ? suggestionMatch[1].trim() : '请查看 discussion 详情';

  return { severity, file, line, ruleId, message, suggestion };
}

/**
 * 根据 GitLab 配置构造远程仓库 HTTPS URL
 */
function buildRemoteUrl(gitlab: GitlabConfig): string {
  const base = gitlab.baseUrl.replace(/\/$/, '');
  const path = gitlab.projectPath.replace(/^\//, '');
  return `${base}/${path}.git`;
}

function getMrReviewConfig(project: Project): MrReviewConfig {
  return (
    project.mrReview ?? {
      enabled: true,
      agentRole: 'reviewer+auto-fixer',
      autoMergeMode: 'audit',
      reviewSchedule: '*/10 * * * *',
      learningEnabled: false,
      maxAutoMergeRisk: 'MEDIUM',
      autoFixEnabled: true,
      resolveOthersDiscussions: true,
    }
  );
}

/**
 * 对单个项目执行 MR 评审轮询
 *
 * 流程：
 * 1. 构造 GitLabProvider
 * 2. 列出所有 open MRs
 * 3. 跳过 draft MR
 * 4. 对每个非 draft MR 获取 diff 和 SHA 信息
 * 5. 调用 ClassicReviewer.review() 生成 findings
 * 6. 根据 agentRole 创建 summary note
 * 7. 仅对 HIGH/CRITICAL 创建 discussion thread（带代码行定位）
 * 8. 记录 finding-discussion 映射
 */
async function reviewProject(
  project: Project,
  llmClient: LlmClient
): Promise<void> {
  if (!project.gitlab) {
    console.log(`[MR Agent] 项目 ${project.name} 未配置 GitLab，跳过`);
    return;
  }

  const config = getMrReviewConfig(project);
  if (!config.enabled) {
    console.log(`[MR Agent] 项目 ${project.name} 未启用 MR 评审，跳过`);
    return;
  }

  const gitlabConfig: GitlabConfig = project.gitlab;
  const provider = new GitLabProvider(gitlabConfig);

  const soul = loadSoulContent(project.rootPath, getArchiveRoot(project));
  const projectContext = loadProjectContext(getArchiveRoot(project));

  const reviewer = new ClassicReviewer({
    client: llmClient,
    tokenBudget: 4000,
    rules: soul?.content ?? '默认评审规则：检查代码质量、安全性、性能问题',
    soulContent: soul?.content,
    projectContext,
  });

  const state = loadState(project);

  console.log(`[MR Agent] 扫描项目 ${project.name} 的 open MRs...`);

  let mrs: MergeRequest[];
  try {
    mrs = await provider.listOpenMRs();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[MR Agent] 列出项目 ${project.name} 的 MR 失败: ${message}`);
    return;
  }

  console.log(`[MR Agent] 项目 ${project.name} 发现 ${mrs.length} 个 open MR`);

  for (const mr of mrs) {
    if (mr.draft) {
      console.log(`[MR Agent] 跳过 draft MR !${mr.iid}: ${mr.title}`);
      continue;
    }

    console.log(`[MR Agent] 评审 MR !${mr.iid}: ${mr.title}`);

    let diffs: MrDiff[];
    try {
      diffs = await provider.getMRDiff(mr.iid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MR Agent] 获取 MR !${mr.iid} diff 失败: ${message}`);
      continue;
    }

    if (diffs.length === 0) {
      console.log(`[MR Agent] MR !${mr.iid} 无变更，跳过`);
      continue;
    }

    let shaInfo;
    try {
      shaInfo = await provider.getMRShaInfo(mr.iid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MR Agent] 获取 MR !${mr.iid} SHA 信息失败: ${message}`);
      continue;
    }

    let result: ReviewResult;
    try {
      result = await reviewer.review(mr, diffs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MR Agent] 评审 MR !${mr.iid} 失败: ${message}`);
      continue;
    }

    if (result.findings.length === 0) {
      console.log(`[MR Agent] MR !${mr.iid} 无发现问题`);
      continue;
    }

    // reviewer / reviewer+auto-fixer 角色发送 summary note
    if (config.agentRole === 'reviewer' || config.agentRole === 'reviewer+auto-fixer') {
      const comment = formatReviewComment(mr, result);
      try {
        await provider.postReviewComment(mr.iid, comment);
        console.log(`[MR Agent] 已在 MR !${mr.iid} 发表 summary 评论`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] 在 MR !${mr.iid} 发表 summary 评论失败: ${message}`);
      }
    }

    // 仅对 HIGH/CRITICAL 创建 discussion thread
    const stateKey = getDiscussionStateKey(mr);
    const postedDiscussions = state.discussions[stateKey] ?? [];
    const postedKeys = new Set(postedDiscussions.map((d) => d.findingKey));

    // 构造 auto-fixer（角色含 auto-fixer 时启用）
    const autoFixEnabled =
      config.agentRole.includes('auto-fixer') && (config.autoFixEnabled ?? true);
    let fixAgent: MrFixAgent | undefined;
    if (autoFixEnabled) {
      const worktreeManager = new WorktreeManager({
        projectId: project.id,
        rootPath: project.rootPath,
        remoteUrl: buildRemoteUrl(gitlabConfig),
      });
      fixAgent = new MrFixAgent({
        worktreeManager,
        reviewer,
        decisionEngine: new FixDecisionEngine(),
      });
    }

    for (const finding of result.findings) {
      if (finding.severity !== 'HIGH' && finding.severity !== 'CRITICAL') {
        continue;
      }

      const key = getFindingKey(finding);
      if (postedKeys.has(key)) {
        console.log(`[MR Agent] finding ${key} 已存在 discussion，跳过`);
        continue;
      }

      const position = buildDiffPosition(finding, diffs, shaInfo);
      if (!position) {
        console.warn(`[MR Agent] 无法为 finding ${key} 构造 diff position，跳过`);
        continue;
      }

      const body = formatFindingDiscussionBody(finding);
      let discussionId: string;
      try {
        discussionId = await provider.createDiscussion(mr.iid, body, position);
        postedDiscussions.push({
          findingKey: key,
          discussionId,
          file: finding.file,
          line: finding.line,
          severity: finding.severity,
          resolved: false,
        });
        console.log(`[MR Agent] 已为 finding ${key} 创建 discussion ${discussionId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] 为 finding ${key} 创建 discussion 失败: ${message}`);
        continue;
      }

      // 自动修复并 resolve discussion
      if (fixAgent) {
        const fixResult = await fixAgent.processFinding(finding, mr);
        if (fixResult.success) {
          try {
            await provider.resolveDiscussion(mr.iid, discussionId);
            const posted = postedDiscussions.find((d) => d.discussionId === discussionId);
            if (posted) posted.resolved = true;
            await provider.addDiscussionNote(
              mr.iid,
              discussionId,
              '✅ CodeKeeper 已自动修复该问题并推送至本分支。'
            );
            console.log(`[MR Agent] 已修复 finding ${key} 并 resolve discussion ${discussionId}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[MR Agent] resolve discussion ${discussionId} 失败: ${message}`);
          }
        } else if (fixResult.action === 'skip' || fixResult.action === 'defer') {
          try {
            await provider.addDiscussionNote(
              mr.iid,
              discussionId,
              `⏸️ CodeKeeper 决定暂不自动修复：${fixResult.reason}`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[MR Agent] 在 discussion ${discussionId} 追加说明失败: ${message}`);
          }
        }
      }
    }

    state.discussions[stateKey] = postedDiscussions;
    saveState(project, state);

    // 处理他人 discussions
    if (config.agentRole.includes('auto-fixer') && (config.resolveOthersDiscussions ?? true)) {
      await handleOthersDiscussions(mr, provider, diffs, shaInfo, fixAgent);
    }
  }
}

/**
 * 处理他人 reviewer 创建的 discussions
 *
 * 对未 resolved 的 discussion：
 * - 尝试解析出 finding
 * - 能解析则尝试自动修复，成功后 resolve 并追加说明
 * - 不能解析或决定不修复则追加说明 comment，不 resolve
 */
async function handleOthersDiscussions(
  mr: MergeRequest,
  provider: GitLabProvider,
  diffs: MrDiff[],
  shaInfo: { baseSha: string; headSha: string; startSha: string },
  fixAgent?: MrFixAgent
): Promise<void> {
  let discussions;
  try {
    discussions = await provider.getDiscussions(mr.iid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[MR Agent] 获取 MR !${mr.iid} discussions 失败: ${message}`);
    return;
  }

  for (const discussion of discussions) {
    if (discussion.resolved || !discussion.resolvable) continue;

    const firstNote = discussion.notes[0];
    if (!firstNote) continue;

    // 跳过自己创建的 discussion（以 CodeKeeper 签名判断）
    if (firstNote.body.includes('CodeKeeper Advance MR 评审 Agent')) continue;

    const inferred = inferFindingFromDiscussion(firstNote.body);
    if (!inferred) {
      try {
        await provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          '👋 CodeKeeper 无法自动解析该讨论，需要人工处理。'
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] 回复 discussion ${discussion.id} 失败: ${message}`);
      }
      continue;
    }

    const position = buildDiffPosition(inferred, diffs, shaInfo);
    if (!position) {
      try {
        await provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          '👋 CodeKeeper 无法在当前 diff 中定位该问题，需要人工处理。'
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] 回复 discussion ${discussion.id} 失败: ${message}`);
      }
      continue;
    }

    if (!fixAgent) {
      try {
        await provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          '👋 CodeKeeper 已识别该问题，但当前未启用自动修复。'
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] 回复 discussion ${discussion.id} 失败: ${message}`);
      }
      continue;
    }

    const finding: ReviewFinding = { ...inferred, autoFixable: false };
    const fixResult = await fixAgent.processFinding(finding, mr);
    if (fixResult.success) {
      try {
        await provider.resolveDiscussion(mr.iid, discussion.id);
        await provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          '✅ CodeKeeper 已根据该讨论自动修复并推送至本分支。'
        );
        console.log(`[MR Agent] 已修复他人 discussion ${discussion.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] resolve 他人 discussion ${discussion.id} 失败: ${message}`);
      }
    } else {
      try {
        await provider.addDiscussionNote(
          mr.iid,
          discussion.id,
          `⏸️ CodeKeeper 决定暂不自动修复：${fixResult.reason}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[MR Agent] 回复 discussion ${discussion.id} 失败: ${message}`);
      }
    }
  }
}

/**
 * MR Agent 主入口
 *
 * 从环境变量加载配置，构造 LlmClient，然后依次评审每个项目。
 * 执行完成后进程正常退出（exit code 0），异常时退出码为 1。
 */
export async function main(): Promise<void> {
  console.log('[MR Agent] 启动 MR 评审轮询...');

  const config = loadConfigFromEnv(process.env);

  if (config.projects.length === 0) {
    console.log('[MR Agent] 没有需要评审的项目，退出');
    return;
  }

  // 解析额外请求头
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(config.llm.headers) as Record<string, string>;
  } catch {
    console.warn('[MR Agent] CK_LLM_HEADERS 解析失败，使用空对象');
  }

  const llmClient = new LlmClient({
    apiKey: config.llm.apiKey,
    provider: config.llm.provider as 'anthropic' | 'openai',
    model: config.llm.model,
    baseURL: config.llm.apiUrl,
    headers,
    maxTokens: 4096,
  });

  for (const project of config.projects) {
    await reviewProject(project, llmClient);
  }

  console.log('[MR Agent] 评审轮询完成');
}

// 直接运行时执行主函数
// 使用 process.argv[1] 判断是否为直接执行（子进程入口）
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('mr-agent-entry.ts') ||
  process.argv[1].endsWith('mr-agent-entry.js')
);
if (isMainModule) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error('[MR Agent] 异常退出:', error);
      process.exit(1);
    }
  );
}
