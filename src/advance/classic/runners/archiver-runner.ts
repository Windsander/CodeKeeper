import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { BaseRoleRunner } from './base-role-runner.js';
import { ArchiverBrain, selectArchiverInputFiles } from '../archive/archiver-brain.js';
import { ArchiverActor } from '../archive/archiver-actor.js';
import { MemoryClient } from '../memory/memory-client.js';
import type { Project, RoleConfig } from '../../types.js';
import type { LlmClient } from '../../llm/client.js';
import { getArchiveRoot } from '../../types.js';
import { loadState, saveState, type MrAgentState } from './shared/state-utils.js';
import type { ProjectKnowledgeItem } from '../memory/types.js';

export interface ArchiverRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
  /** MCP Server URL */
  mcpUrl: string;
}

/**
 * 构建 Archiver 会话 ID（按 8 小时窗口粒度）
 */
export function buildArchiverSessionId(projectId: string, date: Date): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const slot = Math.floor(date.getUTCHours() / 8);
  return `archiver-${projectId}-${yyyy}-${mm}-${dd}-${slot}`;
}

/**
 * Archiver 角色的 Runner 实现
 * 负责扫描项目文件、提炼知识、写入 EverOS
 */
export class ArchiverRunner extends BaseRoleRunner {
  private readonly mcpUrl: string;

  constructor(options: ArchiverRunnerOptions) {
    super({ llmClient: options.llmClient });
    this.mcpUrl = options.mcpUrl;
  }

  protected getRole(): 'archiver' {
    return 'archiver';
  }

  protected getDefaultSchedule(): string {
    return '0 2 * * *';
  }

  /**
   * Archiver 不需要 GitLab 配置，只要本地项目目录存在即可
   */
  protected validatePrerequisites(project: Project): boolean {
    const config = this.getRoleConfig(project);
    if (!config?.enabled) {
      console.log(`[ArchiverRunner] 项目 ${project.name} 未启用，跳过`);
      return false;
    }

    // 父类要求 gitlab，但 archiver 仅依赖本地目录
    return true;
  }

  protected async runProject(project: Project, _config: RoleConfig): Promise<void> {
    console.log(`[ArchiverRunner] 扫描项目 ${project.name}`);

    const archiveRoot = getArchiveRoot(project);
    const files = await this.listProjectFiles(project.rootPath, archiveRoot);
    if (files.length === 0) {
      console.log(`[ArchiverRunner] 项目 ${project.name} 无文件，跳过`);
      return;
    }

    const state = loadState(project);
    const memoryClient = new MemoryClient({
      mcpUrl: this.mcpUrl,
      context: {
        appId: 'codekeeper-advance',
        projectId: project.id,
        agentId: 'archiver',
        userId: 'codekeeper-system',
        sessionId: buildArchiverSessionId(project.id, new Date()),
      },
    });
    try {
      await memoryClient.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ArchiverRunner] MemoryClient 连接失败，本轮不标记完成: ${message}`);
      throw error;
    }

    const brain = new ArchiverBrain({ llmClient: this.llmClient });
    const actor = new ArchiverActor({ memoryClient });
    const sourceFiles = selectArchiverInputFiles(files);
    const sourceFingerprint = this.hash(JSON.stringify(sourceFiles));
    state.archiverState ??= {
      sourceFingerprint: '',
      items: {},
      updatedAt: Date.now(),
    };

    try {
      const pendingRecovered = await this.retryPendingKnowledge(actor, state, project);
      if (!pendingRecovered) {
        console.warn('[ArchiverRunner] 仍有项目知识等待补偿，本轮不重复调用 LLM');
        return;
      }

      if (state.archiverState.sourceFingerprint === sourceFingerprint) {
        console.log('[ArchiverRunner] 项目知识输入未变化，跳过 LLM 分析');
        return;
      }

      const items = await brain.analyzeProject(project, sourceFiles);
      const stableItems = items.map(item => this.stabilizeKnowledgeItem(project.id, item));
      console.log(`[ArchiverRunner] 提炼出 ${stableItems.length} 条项目知识`);

      const pendingItems: ProjectKnowledgeItem[] = [];
      for (const item of stableItems) {
        const existing = state.archiverState.items[item.id];
        if (
          existing?.status === 'recorded' &&
          this.knowledgeItemFingerprint(existing.item) === this.knowledgeItemFingerprint(item)
        ) {
          continue;
        }
        state.archiverState.items[item.id] = {
          item,
          status: 'pending',
          attempts: existing?.attempts ?? 0,
          updatedAt: Date.now(),
        };
        pendingItems.push(item);
      }
      state.archiverState.updatedAt = Date.now();
      saveState(project, state, 'archiver');

      if (pendingItems.length > 0) {
        try {
          await actor.storeKnowledge(pendingItems);
          for (const item of pendingItems) {
            const entry = state.archiverState.items[item.id];
            if (!entry) continue;
            entry.status = 'recorded';
            entry.lastError = undefined;
            entry.updatedAt = Date.now();
          }
          state.archiverState.updatedAt = Date.now();
          saveState(project, state, 'archiver');
          console.log(`[ArchiverRunner] 已提交 ${pendingItems.length} 条项目知识写入`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const item of pendingItems) {
            const entry = state.archiverState.items[item.id];
            if (!entry) continue;
            entry.status = 'failed';
            entry.attempts += 1;
            entry.lastError = message;
            entry.updatedAt = Date.now();
          }
          state.archiverState.updatedAt = Date.now();
          saveState(project, state, 'archiver');
          throw error;
        }
      }
      state.archiverState.sourceFingerprint = sourceFingerprint;
      state.archiverState.updatedAt = Date.now();
      saveState(project, state, 'archiver');
    } finally {
      await memoryClient.disconnect().catch(() => undefined);
    }
  }

  private async listProjectFiles(rootPath: string, archiveRoot: string, subPath = ''): Promise<string[]> {
    const dir = join(rootPath, subPath);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const relativePath = subPath ? `${subPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const absolutePath = join(rootPath, relativePath);
        if (['node_modules', '.git', '.codekeeper', 'dist'].includes(entry.name)) continue;
        // 跳过归档目录及其子目录，避免归档输出被反复扫描
        if (!relative(archiveRoot, absolutePath).startsWith('..')) continue;
        files.push(...(await this.listProjectFiles(rootPath, archiveRoot, relativePath)));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
    return files;
  }

  private async retryPendingKnowledge(
    actor: ArchiverActor,
    state: MrAgentState,
    project: Project
  ): Promise<boolean> {
    const pending = Object.values(state.archiverState?.items ?? {})
      .filter(entry => entry.status !== 'recorded')
      .map(entry => entry.item);
    if (pending.length === 0) return true;

    try {
      await actor.storeKnowledge(pending);
      for (const item of pending) {
        const entry = state.archiverState?.items[item.id];
        if (!entry) continue;
        entry.status = 'recorded';
        entry.lastError = undefined;
        entry.updatedAt = Date.now();
      }
      if (state.archiverState) {
        state.archiverState.updatedAt = Date.now();
        saveState(project, state, 'archiver');
      }
      console.log(`[ArchiverRunner] 已补偿写入 ${pending.length} 条待处理项目知识`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of pending) {
        const entry = state.archiverState?.items[item.id];
        if (!entry) continue;
        entry.status = 'failed';
        entry.attempts += 1;
        entry.lastError = message;
        entry.updatedAt = Date.now();
      }
      if (state.archiverState) {
        state.archiverState.updatedAt = Date.now();
        saveState(project, state, 'archiver');
      }
      console.warn(`[ArchiverRunner] 补偿项目知识写入失败: ${message}`);
      return false;
    }
  }

  private stabilizeKnowledgeItem(projectId: string, item: ProjectKnowledgeItem): ProjectKnowledgeItem {
    const canonical = JSON.stringify({
      sourceId: item.id,
      category: item.category,
      sourceFiles: [...item.sourceFiles].sort(),
    });
    const digest = this.hash(canonical).slice(0, 24);
    return { ...item, id: `archiver-${projectId}-${digest}` };
  }

  private knowledgeItemFingerprint(item: ProjectKnowledgeItem): string {
    return JSON.stringify({
      category: item.category,
      sourceFiles: [...item.sourceFiles].sort(),
      content: item.content,
      confidence: item.confidence,
      relations: item.relations,
      metadata: item.metadata,
    });
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
