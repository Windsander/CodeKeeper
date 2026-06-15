import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLogDir } from '../../core/platform';
import type { MetadataStore } from '../store/metadata-store';
import type { ProjectRegistry } from '../project-registry';
import type { ArchivePipeline } from '../pipeline/archive-pipeline';
import type { LlmClient } from '../llm/client';
import { loadProjectConfig } from '../config/project-config';
import { UndoExecutor } from '../archive/undo-executor';

export interface HandlerContext {
  store: MetadataStore;
  registry: ProjectRegistry;
  getClient: () => LlmClient | null;
  getPipeline: () => ArchivePipeline;
}

export const handlers: Record<string, (ctx: HandlerContext, params: any) => Promise<unknown>> = {
  'project.list': async (ctx) => {
    const projects = ctx.registry.list();
    return projects.map((p) => {
      const counts = ctx.store.getProjectCounts(p.id);
      return {
        ...p,
        ...counts,
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
    const path = join(project.rootPath, '.codekeeper', 'context.md');
    return { content: readFileSync(path, 'utf-8') };
  },

  'project.suggestions': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const path = join(project.rootPath, '.codekeeper', 'suggestions.md');
    return { content: readFileSync(path, 'utf-8') };
  },

  'project.status': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const path = join(project.rootPath, '.codekeeper', 'status.json');
    return JSON.parse(readFileSync(path, 'utf-8'));
  },

  'project.config': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const config = loadProjectConfig(project.rootPath);
    return { content: config };
  },

  'project.config.update': async (ctx, params) => {
    const project = ctx.registry.get(params.projectId);
    if (!project) throw new Error('项目未注册');
    const path = join(project.rootPath, '.codekeeper', 'config.yaml');
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
    const executor = new UndoExecutor({ store: ctx.store, projectRoot: project.rootPath });
    return executor.undo(params.actionId);
  },

  'daemon.config': async (ctx) => {
    return {
      apiKeyConfigured: ctx.getClient() !== null,
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

  'daemon.config.update': async (_ctx, params) => {
    // 实际更新逻辑在 daemon 中处理，这里仅校验
    return { success: true, params };
  },
};
