import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogDir } from '../../core/platform';
import type { MetadataStore } from '../store/metadata-store';
import type { ProjectRegistry } from '../project-registry';
import type { ArchivePipeline } from '../pipeline/archive-pipeline';
import type { LlmClient } from '../llm/client';
import type { Project } from '../types';
import { getArchiveRoot } from '../types';
import { loadProjectConfig } from '../config/project-config';
import { UndoExecutor } from '../archive/undo-executor';

export interface HandlerContext {
  store: MetadataStore;
  registry: ProjectRegistry;
  getClient: () => LlmClient | null;
  getPipeline: () => ArchivePipeline;
  updateDaemonConfig?: (config: {
    apiKey?: string;
    apiUrl?: string;
    provider?: 'anthropic' | 'openai';
    model?: string;
    headers?: Record<string, string>;
    scanCron?: string;
  }) => void;
  getDaemonConfig?: () => {
    apiKeyConfigured: boolean;
    apiUrl: string;
    provider: string;
    model: string;
    headers: string;
    scanCron: string;
  };
  watchProject?: (project: Project) => void;
  unwatchProject?: (projectId: string) => void;
}

export const handlers: Record<string, (ctx: HandlerContext, params: any) => Promise<unknown>> = {
  'project.register': async (ctx, params) => {
    const project = ctx.registry.register(params.rootPath, params.archiveRoot);
    ctx.watchProject?.(project);
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
      if (existsSync(statusPath)) {
        try {
          const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as { healthScore?: number };
          if (typeof status.healthScore === 'number') {
            healthScore = status.healthScore;
          }
        } catch {
          // 状态文件读取失败时回退到默认值
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
    const pipeline = ctx.getPipeline();
    ctx.store.updateLastScannedAt(project.id, Date.now());
    await pipeline.run(project);
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
      apiKeyConfigured: false,
      apiUrl: '',
      provider: 'anthropic',
      model: '',
      headers: '',
      scanCron: '*/5 * * * *',
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
    } = {};

    if (params.apiKey !== undefined) config.apiKey = params.apiKey || undefined;
    if (params.apiUrl !== undefined) config.apiUrl = params.apiUrl || undefined;
    if (params.scanCron !== undefined) config.scanCron = params.scanCron;
    if (params.model !== undefined) config.model = params.model || undefined;

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
};
