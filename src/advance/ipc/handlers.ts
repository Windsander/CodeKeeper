import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogDir } from '../../core/platform';
import { logger } from '../../core/logger';
import type { MetadataStore } from '../store/metadata-store';
import type { ProjectRegistry } from '../project-registry';
import type { LlmClient } from '../llm/client';
import type { Project } from '../types';
import { getArchiveRoot } from '../types';
import { loadProjectConfig } from '../config/project-config';
import { loadDaemonConfig, saveDaemonConfig } from '../config/daemon-config.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_RERANK_MODEL,
} from '../../electron/shared/local-model-catalog.js';
import { UndoExecutor } from '../archive/undo-executor';
import { detectGitInfo } from '../utils/git-info';
import { loadSoulContent, saveSoulContent } from '../classic/soul/soul-loader.js';
import { loadProjectStatus, clearProjectError, recordProjectError } from '../classic/status/project-status-store.js';
import type { ScanService } from '../scan/scan-service.js';
import type { IGitProvider } from '../classic/provider/types.js';
import type { RoleServiceRegistry } from '../classic/role-service-registry.js';
import type { LocalModelServiceManager } from '../classic/memory/local-model-service.js';
import type { ModelCapability } from '../classic/memory/model-server.js';
import { ReviewerManager } from '../classic/roles/reviewer-manager.js';
import { MaintainerManager } from '../classic/roles/maintainer-manager.js';
import type { Role, RoleConfig, GitlabConfig } from '../types.js';
import type { IRoleManager } from '../classic/roles/role-manager.js';

import { readDirectoryTree } from '../utils/file-tree';
import { everosMemorySearch, type EverOSSearchItem, everosMemoryGet, extractOwnersFromGetResult, type EverOSMemoryGetResult, type EverOSMemoryGetParams } from '../classic/memory/everos-api.js';
import { buildMemoryGraph } from '../classic/memory/graph-builder.js';
import type { MemoryEntry, MemorySearchParams, MemoryDeleteParams } from '../../electron/shared/types.js';
import type { DaemonStatus, EverosStatus, LocalModelStatus, RemoteModelStatus } from '../../electron/shared/service-status.js';
import type { RemoteModelChecker } from '../classic/memory/remote-model-checker.js';

export interface HandlerContext {
  store: MetadataStore;
  registry: ProjectRegistry;
  serviceRegistry: RoleServiceRegistry;
  /** 数据库文件路径，供子进程独立打开 metadata store */
  dbPath: string;
  scanService?: ScanService;
  getProvider?: (project: Project) => IGitProvider | null;
  getClient: () => LlmClient | null;
  updateDaemonConfig?: (config: {
    apiKey?: string;
    apiUrl?: string;
    provider?: 'anthropic' | 'openai';
    model?: string;
    headers?: Record<string, string>;
    scanCron?: string;
    llmRequestsPerMinute?: number;
    everos?: import('../config/daemon-config.js').EverOSConfig;
  }) => void;
  getDaemonConfig?: () => {
    apiKey: string;
    apiUrl: string;
    provider: string;
    model: string;
    headers: string;
    scanCron: string;
    llmRequestsPerMinute: number;
    everos: string;
  };
  watchProject?: (project: Project) => void;
  unwatchProject?: (projectId: string) => void;
  /** EverOS HTTP URL，用于 memory.search 等 handler 直接访问 */
  everosUrl?: string;
  /** 本地 Embedding/Rerank 模型服务管理器 */
  localModelManager?: LocalModelServiceManager;
  /** 远端模型连通性检测器 */
  remoteModelChecker?: RemoteModelChecker;
  /** 获取远端模型当前状态 */
  getRemoteModelStatus?: () => RemoteModelStatus;
  /** 判断 Daemon 是否正在运行 */
  isDaemonRunning?: () => boolean;
  /** 获取 EverOS 当前状态 */
  getEverosStatus?: () => EverosStatus;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (ctx: HandlerContext, params: any) => Promise<unknown>> = {
  'project.register': async (ctx, params) => {
    const project = ctx.registry.register(params.rootPath, params.archiveRoot);
    ctx.watchProject?.(project);
    // 全量扫描在独立 worker 中异步执行，不阻塞注册返回，也不阻塞 daemon IPC
    if (ctx.scanService) {
      try {
        ctx.scanService.scanProject(project.id);
        logger.info({ projectId: project.id }, '注册项目时已加入后台扫描队列');
      } catch (err) {
        logger.warn({ err, projectId: project.id }, '注册项目时触发后台扫描失败');
      }
    }

    // 自动从本地 git 检测 GitLab 配置，作为默认配置保存（token 留空待用户填写）
    (async () => {
      try {
        const gitInfo = await detectGitInfo(project.rootPath);
        if (gitInfo.baseUrl && gitInfo.projectPath) {
          ctx.store.updateProjectGitlabConfig(project.id, {
            baseUrl: gitInfo.baseUrl,
            projectPath: gitInfo.projectPath,
            token: '',
            defaultBranch: gitInfo.defaultBranch ?? 'main',
          });
          logger.info(
            { projectId: project.id, baseUrl: gitInfo.baseUrl, projectPath: gitInfo.projectPath },
            '注册项目时自动从 git 配置 GitLab'
          );
        }
      } catch (err) {
        logger.warn({ err, projectId: project.id }, '注册项目时自动检测 git 信息失败');
      }
    })();

    return project;
  },

  'project.unregister': async (ctx, params) => {
    ctx.unwatchProject?.(params.projectId);
    ctx.registry.unregister(params.projectId);
    return { success: true };
  },

  'project.list': async (ctx) => {
    const projects = ctx.registry.list();
    return projects.map((p) => {
      const dbCounts = ctx.store.getProjectCounts(p.id);
      const archiveRoot = getArchiveRoot(p);
      const statusPath = join(archiveRoot, 'status.json');
      let healthScore = 1;
      // status.json 是归档目录的权威状态快照，只要存在就优先使用其统计；
      // 数据库 counts 仅作为 status.json 缺失或字段缺失时的回退。
      let counts = dbCounts;
      if (existsSync(statusPath)) {
        try {
          const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as {
            healthScore?: number;
            pendingCount?: number;
            archivedCount?: number;
            ignoredCount?: number;
            orphanedCount?: number;
            copiedCount?: number;
            organizedCount?: number;
            flaggedCount?: number;
          };
          if (typeof status.healthScore === 'number') {
            healthScore = status.healthScore;
          }
          counts = {
            pending: status.pendingCount ?? dbCounts.pending,
            archived: status.archivedCount ?? dbCounts.archived,
            ignored: status.ignoredCount ?? dbCounts.ignored,
            orphaned: status.orphanedCount ?? dbCounts.orphaned,
            copied: status.copiedCount ?? dbCounts.copied,
            organized: status.organizedCount ?? dbCounts.organized,
            flagged: status.flaggedCount ?? dbCounts.flagged,
          };
        } catch {
          // 状态文件读取失败时回退到数据库统计
        }
      }
      return {
        ...p,
        ...counts,
        healthScore,
        lastScannedAt: p.lastScannedAt,
      };
    });
  },

  'project.get': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const counts = ctx.store.getProjectCounts(project.id);
    return { ...project, ...counts };
  },

  'project.scan': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const client = ctx.getClient();
    if (!client) throw new Error('未配置 API Key');
    if (!ctx.scanService) throw new Error('扫描服务未初始化');
    logger.info({ projectId: project.id, projectRoot: project.rootPath }, '收到手动扫描请求，已加入后台队列');
    ctx.scanService.scanProject(params.projectId);
    return { queued: true, scannedAt: Date.now() };
  },

  'project.context': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const path = join(getArchiveRoot(project), 'context.md');
    return { content: readFileSync(path, 'utf-8') };
  },

  'project.suggestions': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const path = join(getArchiveRoot(project), 'suggestions.md');
    return { content: readFileSync(path, 'utf-8') };
  },

  'project.status': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const path = join(getArchiveRoot(project), 'status.json');
    return JSON.parse(readFileSync(path, 'utf-8'));
  },

  'project.archive.tree': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const archiveRoot = getArchiveRoot(project);
    if (!existsSync(archiveRoot)) {
      return { tree: null };
    }
    return { tree: readDirectoryTree(archiveRoot) };
  },

  'project.config': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const config = loadProjectConfig(project.rootPath, project.archiveRoot);
    return { content: config };
  },

  'project.config.update': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const dir = getArchiveRoot(project);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.yaml');
    writeFileSync(path, params.content, 'utf-8');
    return { success: true };
  },

  'action.history': async (ctx, params) => {
    if (params.projectId === 'all') {
      const projects = ctx.registry.list();
      return projects.flatMap((p) => ctx.store.listActionHistory(p.id));
    }
    return ctx.store.listActionHistory(params.projectId);
  },

  'action.undo': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const executor = new UndoExecutor({ store: ctx.store });
    return executor.undo(params.actionId);
  },

  'daemon.config': async (ctx) => {
    const fromDaemon = ctx.getDaemonConfig?.();
    if (fromDaemon) {
      return fromDaemon;
    }

    // Daemon 尚未启动时，直接从持久化配置读取，避免页面显示空默认值
    const persisted = loadDaemonConfig();
    return {
      apiKey: persisted.apiKey ?? '',
      apiUrl: persisted.apiUrl ?? '',
      provider: persisted.provider ?? 'anthropic',
      model: persisted.model ?? '',
      headers: persisted.headers ? JSON.stringify(persisted.headers) : '',
      scanCron: persisted.scanCron ?? '*/5 * * * *',
      llmRequestsPerMinute: persisted.llmRequestsPerMinute ?? 10,
      embeddingModel: persisted.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      rerankModel: persisted.rerankModel ?? DEFAULT_RERANK_MODEL,
      everos: persisted.everos ? JSON.stringify(persisted.everos) : '',
    };
  },

  'daemon.logs': async (_ctx, params) => {
    const logPath = join(getLogDir(), 'codekeeper.log');
    if (!existsSync(logPath)) {
      return { lines: [] };
    }
    const all = readFileSync(logPath, 'utf-8').split('\n');
    const count = params.lines ?? 100;
    return { lines: all.slice(-count) };
  },

  'role.service.logs': async (_ctx, params) => {
    const logPath = join(getLogDir(), 'codekeeper.log');
    if (!existsSync(logPath)) {
      return { lines: [] };
    }
    const role = (params.role as string) ?? '';
    const roleLower = role.toLowerCase();
    const all = readFileSync(logPath, 'utf-8').split('\n');
    const filtered = all.filter((line) => line.toLowerCase().includes(roleLower));
    const count = params.lines ?? 100;
    return { lines: filtered.slice(-count) };
  },

  'daemon.config.update': async (ctx, params) => {
    const config: import('../config/daemon-config.js').DaemonPersistedConfig = {};

    if (params.apiKey !== undefined) config.apiKey = params.apiKey;
    if (params.apiUrl !== undefined) config.apiUrl = params.apiUrl || undefined;
    if (params.scanCron !== undefined) config.scanCron = params.scanCron;
    if (params.model !== undefined) config.model = params.model || undefined;
    if (params.llmRequestsPerMinute !== undefined) {
      const rpm = Number(params.llmRequestsPerMinute);
      if (!Number.isNaN(rpm) && rpm > 0) {
        config.llmRequestsPerMinute = rpm;
      }
    }
    if (params.embeddingModel !== undefined) {
      config.embeddingModel = params.embeddingModel || undefined;
    }
    if (params.rerankModel !== undefined) {
      config.rerankModel = params.rerankModel || undefined;
    }

    if (params.provider === 'anthropic' || params.provider === 'openai') {
      config.provider = params.provider;
    }

    if (params.headers) {
      try {
        config.headers = JSON.parse(params.headers);
      } catch {
        throw new Error('自定义 Headers 不是合法 JSON');
      }
    } else if (params.headers === '') {
      config.headers = {};
    }

    if (params.everos !== undefined) {
      if (params.everos) {
        try {
          config.everos = JSON.parse(params.everos) as import('../config/daemon-config.js').EverOSConfig;
        } catch {
          throw new Error('EverOS 配置不是合法 JSON');
        }
      } else {
        config.everos = {};
      }
    }

    ctx.updateDaemonConfig?.(config);
    // Daemon 未启动时直接落盘，保证重启后能读取到最新配置
    if (!ctx.updateDaemonConfig) {
      saveDaemonConfig(config);
    }
    return { success: true };
  },

  'classic.start': async (ctx) => {
    await ctx.serviceRegistry.start('reviewer');
    return { running: true };
  },

  'classic.stop': async (ctx) => {
    await ctx.serviceRegistry.stop('reviewer');
    return { running: false };
  },

  'classic.restart': async (ctx) => {
    await ctx.serviceRegistry.stop('reviewer');
    await ctx.serviceRegistry.start('reviewer');
    return { running: true };
  },

  'classic.status': async (ctx) => {
    const projects = ctx.registry.list();
    const enabledProjects = projects.filter(
      (p) => p.mrReview?.enabled && p.gitlab
    ).length;
    const status = ctx.serviceRegistry.getStatus('reviewer');
    return {
      running: status.running,
      enabledProjects,
      runningProjects: status.runningProjects,
    };
  },

  'project.gitlab.config.get': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    return { gitlab: project.gitlab ?? null };
  },

  'project.gitlab.config.update': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const gitlab = params.gitlab;
    if (!gitlab || !gitlab.baseUrl || !gitlab.projectPath) {
      throw new Error('GitLab 配置缺少必要字段');
    }
    const oldGitlab = project.gitlab;
    const updated: NonNullable<typeof project.gitlab> = {
      baseUrl: gitlab.baseUrl,
      projectPath: gitlab.projectPath,
      token: gitlab.token ?? project.gitlab?.token ?? '',
      defaultBranch: gitlab.defaultBranch ?? project.gitlab?.defaultBranch ?? 'main',
    };
    ctx.store.updateProjectGitlabConfig(params.projectId, updated);

    const changed =
      oldGitlab?.baseUrl !== updated.baseUrl ||
      oldGitlab?.projectPath !== updated.projectPath ||
      oldGitlab?.token !== updated.token;
    // GitLab 配置变更且调度服务正在运行时，立即对账以应用变化
    if (changed) {
      await ctx.serviceRegistry.restartProject('reviewer', params.projectId);
    }

    return { success: true };
  },

  'project.gitlab.verify': async (ctx, params) => {
    const { projectId, gitlab } = params as { projectId: string; gitlab: GitlabConfig };
    if (!gitlab || !gitlab.baseUrl || !gitlab.projectPath || !gitlab.token) {
      throw new Error('GitLab 配置缺少必要字段');
    }

    const project = ctx.registry.get(projectId);

    const { GitLabProvider } = await import('../classic/provider/gitlab-provider.js');
    try {
      const provider = new GitLabProvider(gitlab);
      await provider.verify();
      // 验证成功时清除该项目的 Token/API 错误标记
      if (project) {
        clearProjectError(project);
      }
      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/\b(401|403)\b/);
      if (project) {
        if (statusMatch) {
          recordProjectError(project, err, 'invalid-token');
        } else if (message.includes('GitLab API')) {
          recordProjectError(project, err, 'gitlab-api');
        }
      }
      logger.warn({ err: message, gitlab: { baseUrl: gitlab.baseUrl, projectPath: gitlab.projectPath } }, 'GitLab 配置验证失败');
      throw new Error(`GitLab 配置验证失败：${message}`);
    }
  },

  'project.mrreview.config.get': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    return { mrReview: project.mrReview ?? null };
  },

  'project.mrreview.status.get': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    return loadProjectStatus(project);
  },

  'project.members': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project || !ctx.getProvider) return { members: [] };
    const provider = ctx.getProvider(project);
    if (!provider) return { members: [] };
    try {
      return { members: await provider.listMembers() };
    } catch (err) {
      logger.warn({ err, projectId: project.id }, '获取项目成员失败');
      return { members: [] };
    }
  },

  'project.labels': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project || !ctx.getProvider) return { labels: [] };
    const provider = ctx.getProvider(project);
    if (!provider) return { labels: [] };
    try {
      return { labels: await provider.listLabels() };
    } catch (err) {
      logger.warn({ err, projectId: project.id }, '获取项目标签失败');
      return { labels: [] };
    }
  },

  'project.protected-branches': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project || !ctx.getProvider) return { branches: [] };
    const provider = ctx.getProvider(project);
    if (!provider) return { branches: [] };
    try {
      return { branches: await provider.listProtectedBranches() };
    } catch (err) {
      logger.warn({ err, projectId: project.id }, '获取保护分支失败');
      return { branches: [] };
    }
  },

  'project.branches': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project || !ctx.getProvider) return { branches: [] };
    const provider = ctx.getProvider(project);
    if (!provider) return { branches: [] };
    try {
      return { branches: await provider.listBranches() };
    } catch (err) {
      logger.warn({ err, projectId: project.id }, '获取项目分支失败');
      return { branches: [] };
    }
  },

  'project.mrreview.config.update': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const mrReview = params.mrReview;
    if (!mrReview) {
      throw new Error('MR 评审配置不能为空');
    }
    const oldMrReview = project.mrReview;
    const updated: NonNullable<typeof project.mrReview> = {
      enabled: mrReview.enabled ?? false,
      agentRole: mrReview.agentRole ?? 'reviewer+auto-fixer',
      autoMergeMode: mrReview.autoMergeMode ?? 'audit',
      reviewSchedule: mrReview.reviewSchedule ?? '*/10 * * * *',
      learningEnabled: mrReview.learningEnabled ?? false,
      maxAutoMergeRisk: mrReview.maxAutoMergeRisk ?? 'MEDIUM',
      autoFixEnabled: mrReview.autoFixEnabled ?? true,
      resolveOthersDiscussions: mrReview.resolveOthersDiscussions ?? true,
    };
    ctx.store.updateMrReviewConfig(params.projectId, updated);

    const oldEnabled = oldMrReview?.enabled ?? false;
    const newEnabled = updated.enabled;

    if (oldEnabled !== newEnabled) {
      // 启用状态变化后，若调度服务运行中则立即对账
      await ctx.serviceRegistry.restartProject('reviewer', params.projectId);
    } else {
      // 其他字段变化且调度服务运行中，热重启该项目 Agent
      const otherChanged =
        !oldMrReview ||
        oldMrReview.agentRole !== updated.agentRole ||
        oldMrReview.reviewSchedule !== updated.reviewSchedule ||
        oldMrReview.autoFixEnabled !== updated.autoFixEnabled ||
        oldMrReview.resolveOthersDiscussions !== updated.resolveOthersDiscussions ||
        oldMrReview.maxAutoMergeRisk !== updated.maxAutoMergeRisk ||
        JSON.stringify(oldMrReview.filter) !== JSON.stringify(updated.filter);
      if (otherChanged) {
        await ctx.serviceRegistry.restartProject('reviewer', params.projectId);
      }
    }

    return { success: true };
  },

  'project.git.detect': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    return detectGitInfo(project.rootPath);
  },

  'project.soul.get': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    return { soul: loadSoulContent(project, 'reviewer') };
  },

  'project.soul.update': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const content = params.content ?? '';
    await saveSoulContent(project, 'reviewer', content);
    return { success: true };
  },

  // ---------- 记忆浏览器 IPC Handler ----------

  'memory.search': async (ctx, params) => {
    const { projectId, agentId, userId, query, limit } = params as MemorySearchParams;
    if (!projectId) throw new Error('项目 ID 不能为空');
    if (!agentId && !userId) throw new Error('必须指定 agentId 或 userId');
    if (!ctx.everosUrl) throw new Error('EverOS 服务未启动');

    const project = ctx.registry.get(projectId);
    if (!project) throw new Error('项目未注册');

    const owner = agentId
      ? { kind: 'agent' as const, agentId }
      : { kind: 'user' as const, userId: userId as string };

    const result = await everosMemorySearch(ctx.everosUrl, {
      appId: 'codekeeper-advance',
      projectId,
      owner,
      query: query ?? '',
      topK: limit ?? 20,
    });

    const deletedSessions = new Set(ctx.store.listDeletedMemorySessions(projectId));
    const entries: MemoryEntry[] = result.items
      .filter((item) => !deletedSessions.has(item.sessionId ?? ''))
      .map((item) => mapEverOSSearchItemToMemoryEntry(item));

    return { entries };
  },

  'memory.delete': async (ctx, params) => {
    const { projectId, sessionId } = params as MemoryDeleteParams;
    if (!projectId || !sessionId) throw new Error('项目 ID 和 sessionId 不能为空');
    ctx.store.markMemorySessionDeleted(projectId, sessionId);
    return { success: true };
  },

  'memory.graph': async (ctx) => {
    const projects = ctx.registry.list();

    // EverOS 尚未就绪时返回空记忆数据（保留项目节点），避免 UI 轮询抛错
    if (!ctx.everosUrl) {
      return buildMemoryGraph({
        projects: projects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
        getResults: new Map(),
      });
    }

    const knownUsers = new Set<string>(['codekeeper-system']);
    const knownAgents = new Set<string>(['reviewer', 'maintainer', 'archiver']);
    const ownerDisplayNames = new Map<string, string>();
    const getResults = new Map<string, EverOSMemoryGetResult>();

    // RoleAgent 在 EverOS 中以 user sender 写入，但 agent_id 带有 role 前缀；
    // 收集 owner 时需避免把这类 id 同时当作真实用户。
    const isAgentLikeOwnerId = (ownerId: string): boolean =>
      /^(reviewer|maintainer|archiver)-/.test(ownerId);

    // 单个 owner 查询失败时不应导致整张图谱加载失败，返回空结果并记录警告
    const safeEverosMemoryGet = async (
      params: EverOSMemoryGetParams
    ): Promise<EverOSMemoryGetResult> => {
      try {
        return await everosMemoryGet(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, projectId: params.projectId, ownerKind: params.ownerKind, ownerId: params.ownerId, memoryType: params.memoryType },
          `EverOS memory/get 查询失败，跳过: ${message}`
        );
        return { episodes: [], profiles: [], agent_cases: [], agent_skills: [], total_count: 0 };
      }
    };

    // 从 metadata store 读取本项目已注册的记忆 owner（真实用户 + Agent）
    for (const project of projects) {
      for (const { ownerId, ownerType, displayName } of ctx.store.listMemoryOwners(project.id)) {
        if (ownerType === 'agent' || isAgentLikeOwnerId(ownerId)) {
          knownAgents.add(ownerId);
        } else {
          knownUsers.add(ownerId);
        }
        if (displayName) {
          ownerDisplayNames.set(ownerId, displayName);
        }
      }
    }

    // 第一轮：用已知 agent 拉取 agent 侧数据，同时从 agent_case 中发现用户
    for (const project of projects) {
      const projectResult: EverOSMemoryGetResult = {
        episodes: [], profiles: [], agent_cases: [], agent_skills: [], total_count: 0,
      };

      for (const agentId of knownAgents) {
        const caseRes = await safeEverosMemoryGet({
          everosUrl: ctx.everosUrl,
          appId: 'codekeeper-advance',
          projectId: project.id,
          ownerKind: 'agent',
          ownerId: agentId,
          memoryType: 'agent_case',
        });
        const skillRes = await safeEverosMemoryGet({
          everosUrl: ctx.everosUrl,
          appId: 'codekeeper-advance',
          projectId: project.id,
          ownerKind: 'agent',
          ownerId: agentId,
          memoryType: 'agent_skill',
        });
        mergeResult(projectResult, caseRes);
        mergeResult(projectResult, skillRes);

        const caseOwners = extractOwnersFromGetResult(caseRes);
        for (const uid of caseOwners.users) {
          if (!isAgentLikeOwnerId(uid)) knownUsers.add(uid);
        }
      }

      getResults.set(project.id, projectResult);
    }


    // 第二轮：用发现的 users 拉取 user 侧数据
    for (const project of projects) {
      const projectResult = getResults.get(project.id);
      if (!projectResult) {
        continue;
      }
      for (const userId of knownUsers) {
        const episodeRes = await safeEverosMemoryGet({
          everosUrl: ctx.everosUrl,
          appId: 'codekeeper-advance',
          projectId: project.id,
          ownerKind: 'user',
          ownerId: userId,
          memoryType: 'episode',
        });
        const profileRes = await safeEverosMemoryGet({
          everosUrl: ctx.everosUrl,
          appId: 'codekeeper-advance',
          projectId: project.id,
          ownerKind: 'user',
          ownerId: userId,
          memoryType: 'profile',
        });
        mergeResult(projectResult, episodeRes);
        mergeResult(projectResult, profileRes);

        // 从 episodes 里也收集用户，避免 agent_case 为空时遗漏真实用户
        const episodeOwners = extractOwnersFromGetResult(episodeRes);
        for (const uid of episodeOwners.users) {
          if (!isAgentLikeOwnerId(uid)) knownUsers.add(uid);
        }
      }
    }

    const graph = buildMemoryGraph({
      projects: projects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
      getResults,
      ownerDisplayNames,
    });
    return graph;
  },

  // ---------- Daemon 状态 IPC Handler ----------

  'daemon.status': async (ctx) => {
    return {
      daemonRunning: ctx.isDaemonRunning?.() ?? false,
      everos: ctx.getEverosStatus?.() ?? { state: 'idle', url: null, error: null },
    } satisfies DaemonStatus;
  },

  // ---------- 本地模型服务 IPC Handler ----------

  'localModel.status': async (ctx) => {
    return (
      ctx.localModelManager?.getStatus() ?? {
        embedding: { state: 'idle', url: null, error: null, progress: null },
        rerank: { state: 'idle', url: null, error: null, progress: null },
      }
    ) satisfies LocalModelStatus;
  },

  'localModel.logs': async (ctx, params) => {
    const capability = params.capability as string;
    if (capability !== 'embedding' && capability !== 'rerank') {
      throw new Error(`无效的模型能力: ${capability}`);
    }
    const lines = ctx.localModelManager?.getModelLogs(capability as ModelCapability, params.lines ?? 200) ?? [];
    return { lines };
  },

  // ---------- 远端模型服务 IPC Handler ----------

  'remoteModel.status': async (ctx) => {
    return (
      ctx.getRemoteModelStatus?.() ?? {
        llm: { state: 'unconfigured', modelLabel: '未配置', fullModel: '', baseUrl: null, error: null, lastCheckedAt: 0 },
        multimodal: { state: 'unconfigured', modelLabel: '未配置', fullModel: '', baseUrl: null, error: null, lastCheckedAt: 0 },
      }
    ) satisfies RemoteModelStatus;
  },

  // ---------- 角色 IPC Handler ----------

  'project.role.config.get': async (ctx, params) => {
    const { projectId, role } = params as { projectId: string; role: Role };
    const manager = createRoleManager(role, ctx.store);
    const config = await manager.getConfig(projectId);
    return { config };
  },

  'project.role.config.update': async (ctx, params) => {
    const { projectId, role, config } = params as { projectId: string; role: Role; config: RoleConfig };
    const manager = createRoleManager(role, ctx.store);
    await manager.updateConfig(projectId, config);
    // 触发服务重启由后续 task 补齐
    return { success: true };
  },

  'project.role.status.get': async (ctx, params) => {
    const { projectId, role } = params as { projectId: string; role: Role };
    const manager = createRoleManager(role, ctx.store);
    return manager.getStatus(projectId);
  },

  'role.service.start': async (ctx, params) => {
    const { role } = params as { role: Role };
    if (!ctx.serviceRegistry) throw new Error('角色服务注册表未初始化');
    await ctx.serviceRegistry.start(role);
    return { success: true };
  },

  'role.service.stop': async (ctx, params) => {
    const { role } = params as { role: Role };
    if (!ctx.serviceRegistry) throw new Error('角色服务注册表未初始化');
    await ctx.serviceRegistry.stop(role);
    return { success: true };
  },

  'role.service.restart': async (ctx, params) => {
    const { role, projectId } = params as { role: Role; projectId?: string };
    if (!ctx.serviceRegistry) throw new Error('角色服务注册表未初始化');
    await ctx.serviceRegistry.restartProject(role, projectId ?? '');
    return { success: true };
  },

  'role.service.status': async (ctx, params) => {
    const { role } = params as { role: Role };
    if (!ctx.serviceRegistry) throw new Error('角色服务注册表未初始化');
    return ctx.serviceRegistry.getStatus(role);
  },
};

function mapEverOSSearchItemToMemoryEntry(item: EverOSSearchItem): MemoryEntry {
  return {
    id: item.id,
    type: normalizeMemoryEntryType(item.type),
    content: item.content,
    source: item.source ?? item.type,
    timestamp: item.timestamp ?? new Date().toISOString(),
    sessionId: item.sessionId ?? '',
    score: item.score,
  };
}

function normalizeMemoryEntryType(type: string): MemoryEntry['type'] {
  if (type === 'agent_case' || type === 'episode' || type === 'agent_skill' || type === 'profile') {
    return type;
  }
  return 'agent_case';
}

function createRoleManager(role: Role, store: MetadataStore): IRoleManager {
  switch (role) {
    case 'reviewer':
      return new ReviewerManager(store);
    case 'maintainer':
      return new MaintainerManager(store);
    default:
      throw new Error(`未支持的角色: ${role}`);
  }
}

function mergeResult(target: EverOSMemoryGetResult, source: EverOSMemoryGetResult): void {
  target.episodes.push(...source.episodes);
  target.profiles.push(...source.profiles);
  target.agent_cases.push(...source.agent_cases);
  target.agent_skills.push(...source.agent_skills);
  target.total_count += source.total_count;
}
