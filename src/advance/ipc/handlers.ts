import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogDir } from '../../core/platform';
import { logger } from '../../core/logger';
import type { MetadataStore } from '../store/metadata-store';
import type { ProjectRegistry } from '../project-registry';
import type { ArchivePipeline } from '../pipeline/archive-pipeline';
import type { LlmClient } from '../llm/client';
import type { Project } from '../types';
import { getArchiveRoot } from '../types';
import { loadProjectConfig } from '../config/project-config';
import { scanExistingFiles } from '../project-scanner';
import { UndoExecutor } from '../archive/undo-executor';
import type { ClassicService } from '../classic/classic-service';

import { readDirectoryTree } from '../utils/file-tree';

export interface HandlerContext {
  store: MetadataStore;
  registry: ProjectRegistry;
  classicService?: ClassicService;
  getClient: () => LlmClient | null;
  getPipeline: () => ArchivePipeline;
  updateDaemonConfig?: (config: {
    apiKey?: string;
    apiUrl?: string;
    provider?: 'anthropic' | 'openai';
    model?: string;
    headers?: Record<string, string>;
    scanCron?: string;
    llmRequestsPerMinute?: number;
  }) => void;
  getDaemonConfig?: () => {
    apiKey: string;
    apiUrl: string;
    provider: string;
    model: string;
    headers: string;
    scanCron: string;
    llmRequestsPerMinute: number;
  };
  watchProject?: (project: Project) => void;
  unwatchProject?: (projectId: string) => void;
}

export const handlers: Record<string, (ctx: HandlerContext, params: any) => Promise<unknown>> = {
  'project.register': async (ctx, params) => {
    const project = ctx.registry.register(params.rootPath, params.archiveRoot);
    ctx.watchProject?.(project);
    // 全量扫描可能耗时较长，放到后台执行，避免阻塞注册返回
    setImmediate(() => {
      try {
        const config = loadProjectConfig(project.rootPath, project.archiveRoot);
        const scannedCount = scanExistingFiles(ctx.store, project, config);
        logger.info({ projectId: project.id, scannedCount }, '注册项目时全量扫描完成');
      } catch (err) {
        logger.warn({ err, projectId: project.id }, '注册项目时全量扫描失败');
      }
    });
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
      const counts = ctx.store.getProjectCounts(p.id);
      const archiveRoot = getArchiveRoot(p);
      const statusPath = join(archiveRoot, 'status.json');
      let healthScore = 1;
      const statusCounts: Partial<typeof counts> = {};
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
          // 当数据库统计被清空（如注销后重新注册）但归档目录仍有 status.json 时，
          // 用 status.json 中的统计作为回退，避免卡片只显示健康度。
          const allZero = Object.values(counts).every((v) => v === 0);
          if (allZero) {
            statusCounts.pending = status.pendingCount;
            statusCounts.archived = status.archivedCount;
            statusCounts.ignored = status.ignoredCount;
            statusCounts.orphaned = status.orphanedCount;
            statusCounts.copied = status.copiedCount;
            statusCounts.organized = status.organizedCount;
            statusCounts.flagged = status.flaggedCount;
          }
        } catch {
          // 状态文件读取失败时回退到默认值
        }
      }
      return {
        ...p,
        ...counts,
        ...statusCounts,
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
    logger.info({ projectId: project.id, projectRoot: project.rootPath }, '收到手动扫描请求');
    const pipeline = ctx.getPipeline();
    ctx.store.updateLastScannedAt(project.id, Date.now());
    await pipeline.run(project);
    logger.info({ projectId: project.id }, '手动扫描完成');
    return { scannedAt: Date.now() };
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
    return ctx.getDaemonConfig?.() ?? {
      apiKey: '',
      apiUrl: '',
      provider: 'anthropic',
      model: '',
      headers: '',
      scanCron: '*/5 * * * *',
      llmRequestsPerMinute: 10,
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

  'daemon.config.update': async (ctx, params) => {
    const config: {
      apiKey?: string;
      apiUrl?: string;
      provider?: 'anthropic' | 'openai';
      model?: string;
      headers?: Record<string, string>;
      scanCron?: string;
      llmRequestsPerMinute?: number;
    } = {};

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

    ctx.updateDaemonConfig?.(config);
    return { success: true };
  },

  'classic.start': async (ctx) => {
    ctx.classicService?.start();
    return { running: ctx.classicService?.isRunning() ?? false };
  },

  'classic.stop': async (ctx) => {
    ctx.classicService?.stop();
    return { running: ctx.classicService?.isRunning() ?? false };
  },

  'classic.restart': async (ctx) => {
    ctx.classicService?.restart();
    return { running: ctx.classicService?.isRunning() ?? false };
  },

  'classic.status': async (ctx) => {
    const projects = ctx.registry.list();
    const enabledProjects = projects.filter(
      (p) => p.mrReview?.enabled && p.gitlab
    ).length;
    return {
      running: ctx.classicService?.isRunning() ?? false,
      enabledProjects,
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
    const updated: NonNullable<typeof project.gitlab> = {
      baseUrl: gitlab.baseUrl,
      projectPath: gitlab.projectPath,
      token: gitlab.token ?? project.gitlab?.token ?? '',
      defaultBranch: gitlab.defaultBranch ?? project.gitlab?.defaultBranch ?? 'main',
    };
    ctx.store.updateProjectGitlabConfig(params.projectId, updated);
    return { success: true };
  },

  'project.mrreview.config.get': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    return { mrReview: project.mrReview ?? null };
  },

  'project.mrreview.config.update': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const mrReview = params.mrReview;
    if (!mrReview) {
      throw new Error('MR 评审配置不能为空');
    }
    const updated: NonNullable<typeof project.mrReview> = {
      enabled: mrReview.enabled ?? false,
      autoMergeMode: mrReview.autoMergeMode ?? 'audit',
      reviewSchedule: mrReview.reviewSchedule ?? '*/10 * * * *',
      learningEnabled: mrReview.learningEnabled ?? false,
      maxAutoMergeRisk: mrReview.maxAutoMergeRisk ?? 'MEDIUM',
    };
    ctx.store.updateMrReviewConfig(params.projectId, updated);
    return { success: true };
  },
};
