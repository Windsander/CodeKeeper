import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep, type PlatformPath } from 'node:path';
import { BaseRoleRunner } from './base-role-runner.js';
import { ArchiverBrain, selectArchiverInputFiles } from '../archive/archiver-brain.js';
import { ArchiverActor } from '../archive/archiver-actor.js';
import { MemoryClient } from '../memory/memory-client.js';
import type { Project, RoleConfig } from '../../types.js';
import type { LlmClient } from '../../llm/client.js';
import { getArchiveRoot, isRoleConfigEnabled } from '../../types.js';
import {
  normalizeArchiverConfig,
} from '../../archiver/provider-config.js';
import {
  type ArchiverProviderCoordinator,
  type ArchiverProviderExecution,
} from '../../archiver/provider-orchestrator.js';
import { createArchiverProviderCoordinator } from '../../archiver/codegraph-client.js';
import { loadState, saveState, type MrAgentState } from './shared/state-utils.js';
import { buildEverOSAgentId, type ProjectKnowledgeItem } from '../memory/types.js';

const ARCHIVER_SCAN_EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.codekeeper',
  'dist',
  '.repowise',
  '.codebase-memory',
  'graphify-out',
]);
const ARCHIVER_SCAN_EXCLUDED_FILES = new Set(['.graphify_detect.json']);

export interface ArchiverRunnerOptions {
  /** LLM 客户端实例 */
  llmClient: LlmClient;
  /** MCP Server URL */
  mcpUrl: string;
  /** Provider 编排器，默认使用系统注册表 */
  providerOrchestrator?: ArchiverProviderCoordinator;
  /** Daemon 托管的 CodeGraph Server URL */
  codeGraphUrl?: string;
}

export function buildArchiverMemoryContext(
  projectId: string,
  archiverName: string,
  sessionId: string
) {
  return {
    appId: 'codekeeper-advance',
    projectId,
    agentId: buildEverOSAgentId('archiver', archiverName),
    agentDisplayName: archiverName,
    userId: 'codekeeper-system',
    sessionId,
  };
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
 * 为 Archiver 选中的输入文件生成稳定指纹。
 *
 * 文件名保持不变但内容发生变化时，也必须重新触发知识提炼；
 * 不把正文写入状态，只保存每个文件内容的摘要。
 */
export function buildArchiverSourceFingerprint(
  sourceFiles: string[],
  fileContents: Record<string, string | undefined>
): string {
  const canonical = [...new Set(sourceFiles)].sort().map(file => ({
    file,
    contentHash: createHash('sha256')
      .update(fileContents[file] ?? '<unreadable>')
      .digest('hex'),
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** 判断目录项是否属于依赖、归档或 Provider 生成物。 */
export function isArchiverScanEntryExcluded(entryName: string, isDirectory: boolean): boolean {
  return (isDirectory ? ARCHIVER_SCAN_EXCLUDED_DIRECTORIES : ARCHIVER_SCAN_EXCLUDED_FILES).has(
    entryName
  );
}

/**
 * Archiver 角色的 Runner 实现
 * 负责扫描项目文件、提炼知识、写入 EverOS
 */
export class ArchiverRunner extends BaseRoleRunner {
  private readonly mcpUrl: string;
  private readonly providerOrchestrator: ArchiverProviderCoordinator;

  constructor(options: ArchiverRunnerOptions) {
    super({ llmClient: options.llmClient });
    this.mcpUrl = options.mcpUrl;
    this.providerOrchestrator =
      options.providerOrchestrator ?? createArchiverProviderCoordinator(options.codeGraphUrl);
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
    if (!isRoleConfigEnabled(config)) {
      console.log(`[ArchiverRunner] 项目 ${project.name} 未启用，跳过`);
      return false;
    }

    try {
      if (!existsSync(project.rootPath) || !statSync(project.rootPath).isDirectory()) {
        console.warn(`[ArchiverRunner] 项目 ${project.name} 的本地目录不存在，跳过`);
        return false;
      }
    } catch {
      console.warn(`[ArchiverRunner] 项目 ${project.name} 的本地目录不可访问，跳过`);
      return false;
    }

    return true;
  }

  protected async runProject(project: Project, config: RoleConfig): Promise<void> {
    console.log(`[ArchiverRunner] 扫描项目 ${project.name}`);

    const archiveRoot = getArchiveRoot(project);
    const archiverConfig = normalizeArchiverConfig(config);
    const providerExecution = await this.syncProviders(project, archiveRoot);
    if (!providerExecution.shouldRunBuiltin) {
      if (!providerExecution.report.selectedPrimary) {
        const details = providerExecution.report.statuses
          .filter(status => status.placement !== 'enricher')
          .map(status => `${status.providerId}: ${status.message ?? status.state}`)
          .join('；');
        throw new Error(
          `Archiver 未找到可用的主 Provider，且内置安全回退已关闭${details ? `：${details}` : ''}`
        );
      }
      console.log(
        `[ArchiverRunner] Provider ${providerExecution.report.selectedPrimary} 已完成，本轮无需内置提炼`
      );
      return;
    }

    let builtinFinalized = false;
    const finalizeBuiltin = async (success: boolean, message: string) => {
      if (builtinFinalized) return;
      builtinFinalized = true;
      await this.providerOrchestrator
        .finalizeBuiltin(project, archiveRoot, providerExecution.report, success, message)
        .catch(error => {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[ArchiverRunner] Provider 状态写入失败: ${detail}`);
        });
    };
    const failBuiltin = async (message: string, error?: unknown) => {
      await finalizeBuiltin(false, message);
      if (providerExecution.builtinRequired) {
        throw error instanceof Error ? error : new Error(message);
      }
      console.warn(`[ArchiverRunner] 内置增强阶段失败，不影响已完成的主 Provider: ${message}`);
    };

    const files = await this.listProjectFiles(project.rootPath, archiveRoot);
    if (files.length === 0) {
      console.log(`[ArchiverRunner] 项目 ${project.name} 无文件，跳过`);
      await finalizeBuiltin(true, '项目无可分析文件，内置阶段已跳过');
      return;
    }

    const state = loadState(project);
    const archiverName = archiverConfig.archiverName.trim() || 'CodeKeeper Archiver';
    const memoryClient = new MemoryClient({
      mcpUrl: this.mcpUrl,
      context: buildArchiverMemoryContext(
        project.id,
        archiverName,
        buildArchiverSessionId(project.id, new Date())
      ),
    });
    try {
      await memoryClient.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ArchiverRunner] MemoryClient 连接失败，本轮不标记完成: ${message}`);
      await failBuiltin(`内置知识提炼失败：${message}`, error);
      return;
    }

    const brain = new ArchiverBrain({ llmClient: this.llmClient });
    const actor = new ArchiverActor({ memoryClient });
    const sourceFiles = selectArchiverInputFiles(files);
    const fileContents = await this.readSourceFiles(project.rootPath, sourceFiles);
    const sourceFingerprint = buildArchiverSourceFingerprint(sourceFiles, fileContents);
    state.archiverState ??= {
      sourceFingerprint: '',
      items: {},
      updatedAt: Date.now(),
    };

    try {
      const pendingRecovered = await this.retryPendingKnowledge(actor, state, project);
      if (!pendingRecovered) {
        console.warn('[ArchiverRunner] 仍有项目知识等待补偿，本轮不重复调用 LLM');
        await failBuiltin('仍有项目知识等待补偿写入');
        return;
      }

      if (state.archiverState.sourceFingerprint === sourceFingerprint) {
        console.log('[ArchiverRunner] 项目知识输入未变化，跳过 LLM 分析');
        await finalizeBuiltin(true, '项目知识输入未变化，无需重复提炼');
        return;
      }

      const items = await brain.analyzeProject(project, sourceFiles, fileContents);
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
      await finalizeBuiltin(true, `内置知识提炼完成，共处理 ${stableItems.length} 条知识`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failBuiltin(`内置知识提炼失败：${message}`, error);
    } finally {
      await memoryClient.disconnect().catch(() => undefined);
    }
  }

  private async syncProviders(
    project: Project,
    archiveRoot: string
  ): Promise<ArchiverProviderExecution> {
    try {
      return await this.providerOrchestrator.syncProject(project, archiveRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ArchiverRunner] Provider 编排失败，回退到内置知识提炼: ${message}`);
      const now = Date.now();
      return {
        shouldRunBuiltin: true,
        builtinRequired: true,
        report: {
          schemaVersion: 1,
          projectId: project.id,
          generatedAt: now,
          selectedPrimary: 'builtin',
          statuses: [
            {
              providerId: 'builtin',
              placement: 'fallback',
              state: 'deferred',
              startedAt: now,
              finishedAt: now,
              message: `Provider 编排失败，等待内置阶段：${message}`,
            },
          ],
        },
      };
    }
  }

  private async listProjectFiles(
    rootPath: string,
    archiveRoot: string,
    subPath = ''
  ): Promise<string[]> {
    const dir = join(rootPath, subPath);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const relativePath = subPath ? `${subPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const absolutePath = join(rootPath, relativePath);
        if (isArchiverScanEntryExcluded(entry.name, true)) continue;
        // 跳过归档目录及其子目录，避免归档输出被反复扫描
        if (isPathInside(archiveRoot, absolutePath)) continue;
        files.push(...(await this.listProjectFiles(rootPath, archiveRoot, relativePath)));
      } else if (entry.isFile()) {
        if (isArchiverScanEntryExcluded(entry.name, false)) continue;
        files.push(relativePath);
      }
    }
    return files;
  }

  private async readSourceFiles(
    rootPath: string,
    sourceFiles: string[]
  ): Promise<Record<string, string | undefined>> {
    const fileContents: Record<string, string | undefined> = {};
    await Promise.all(
      sourceFiles.map(async file => {
        fileContents[file] = await readFile(join(rootPath, file), 'utf8').catch(() => undefined);
      })
    );
    return fileContents;
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

  private stabilizeKnowledgeItem(
    projectId: string,
    item: ProjectKnowledgeItem
  ): ProjectKnowledgeItem {
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

const CURRENT_PLATFORM_PATH: Pick<PlatformPath, 'relative' | 'isAbsolute' | 'sep'> = {
  relative,
  isAbsolute,
  sep,
};

/** 判断候选路径是否位于父目录内，兼容 Windows 跨盘符路径。 */
export function isPathInside(
  parentPath: string,
  candidatePath: string,
  pathApi: Pick<PlatformPath, 'relative' | 'isAbsolute' | 'sep'> = CURRENT_PLATFORM_PATH
): boolean {
  const relativePath = pathApi.relative(parentPath, candidatePath);
  return (
    relativePath === '' ||
    (!pathApi.isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${pathApi.sep}`))
  );
}
