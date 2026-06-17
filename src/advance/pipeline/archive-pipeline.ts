import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { minimatch } from 'minimatch';
import { ArchiveExecutor } from '../archive/archive-executor';
import { DocumentClassifier } from '../archive/classifier';
import { parseDocument } from '../archive/document-parser';
import { computeArchivePath } from '../archive/archive-path';
import { SuggestionEngine } from '../archive/suggestion-engine';
import { generateContext } from '../codekeeper/context-generator';
import { updateStatus, buildProjectStatus } from '../codekeeper/status-updater';
import { writeSuggestions } from '../codekeeper/suggestions-writer';
import { writeReadme } from '../codekeeper/readme-writer';
import type { LlmClient } from '../llm/client';
import type { MetadataStore } from '../store/metadata-store';
import type { Project, ArchiveAction, ClassificationResult } from '../types';
import { getArchiveRoot } from '../types';
import { loadProjectConfig } from '../config/project-config';
import { logger } from '../../core/logger';

export interface ArchivePipelineOptions {
  store: MetadataStore;
  client: LlmClient;
  /** 最大处理事件数，默认 50 */
  maxEvents?: number;
}

/**
 * 归档管道：编排分类、去重、建议、执行与文件生成
 * 图书管理员模式：只复制原文件到 archiveRoot，原文件不动；在 archiveRoot 内重新组织。
 */
export class ArchivePipeline {
  private options: Required<Pick<ArchivePipelineOptions, 'maxEvents'>> &
    Omit<ArchivePipelineOptions, 'maxEvents'>;

  constructor(options: ArchivePipelineOptions) {
    this.options = {
      ...options,
      maxEvents: options.maxEvents ?? 50,
    };
  }

  async run(project: Project): Promise<void> {
    const events = this.options.store.listPendingEvents(this.options.maxEvents);
    logger.info({ projectId: project.id, projectRoot: project.rootPath, eventCount: events.length }, '开始归档扫描');
    if (events.length === 0) {
      logger.info('没有待处理的文件事件，跳过本次扫描');
      await this.reconcileArchived(project);
      const allContextEntries = this.buildContextEntries(project.id);
      this.generateReports(project, allContextEntries, 'success');
      return;
    }

    const now = Date.now();
    const archiveRoot = getArchiveRoot(project);

    const config = loadProjectConfig(project.rootPath, project.archiveRoot);
    const classifier = new DocumentClassifier(this.options.client, {
      categories: config.categories.length > 0 ? config.categories : undefined,
      docTypes: config.docTypes.length > 0 ? config.docTypes : undefined,
    });
    const suggest = new SuggestionEngine(this.options.client);
    const executor = new ArchiveExecutor({ archiveRoot });

    const existingMetadata = this.options.store.listArchiveMetadataByProject(project.id);
    const existingBySource = new Map(existingMetadata.map((m) => [m.sourcePath, m]));
    const existingArchivePaths = new Set(existingMetadata.map((m) => m.archivePath.toLowerCase()));

    const processedEventIds: number[] = [];
    const executedIds: string[] = [];

    for (const event of events) {
      try {
        const relPath = relative(project.rootPath, event.filePath).replace(/\\/g, '/');
        if (config.exclude.some((pattern) => minimatch(relPath, pattern, { dot: true }))) {
          processedEventIds.push(event.eventId);
          continue;
        }

        if (event.type === 'unlink') {
          await this.handleUnlink(project, event.filePath, existingBySource, now);
          processedEventIds.push(event.eventId);
          continue;
        }

        if (!existsSync(event.filePath)) {
          logger.warn({ filePath: event.filePath }, '事件对应文件已不存在，跳过');
          processedEventIds.push(event.eventId);
          continue;
        }

        const doc = parseDocument(event.filePath);
        const entryId = makeEntryId(project.id, event.filePath);
        const classification = await classifier.classify(event.filePath, doc.content);
        const archivePath = computeArchivePath({
          archiveRoot,
          sourcePath: event.filePath,
          category: classification.category,
          docType: classification.docType,
          date: new Date(doc.modifiedAt),
          existingPaths: existingArchivePaths,
        });

        const existing = existingBySource.get(event.filePath);
        const action = await this.decideAction(
          event.filePath,
          doc.content,
          classification,
          archivePath,
          existing ?? null,
          suggest
        );

        this.options.store.insertAction({ ...action, projectId: project.id });

        const result = await executor.execute(action);
        if (result.success) {
          executedIds.push(action.id);
          this.options.store.insertActionHistory({ ...action, projectId: project.id });

          const finalArchivePath = result.finalArchivePath ?? archivePath;
          const status: 'archived' | 'ignored' | 'orphaned' =
            action.type === 'ignore' ? 'ignored' : 'archived';

          this.options.store.upsertEntry({
            id: entryId,
            projectId: project.id,
            filePath: event.filePath,
            contentHash: doc.contentHash,
            status,
            createdAt: existing?.copiedAt ?? now,
            updatedAt: now,
          });

          if (status === 'archived') {
            this.options.store.upsertArchiveMetadata({
              entryId,
              projectId: project.id,
              sourcePath: event.filePath,
              archivePath: finalArchivePath,
              category: classification.category,
              docType: classification.docType,
              tags: classification.tags,
              summary: classification.summary,
              contentHash: doc.contentHash,
              copiedAt: existing?.copiedAt ?? now,
              organizedAt: action.type === 'organize' ? now : (existing?.organizedAt ?? undefined),
              status: 'active',
              type: action.type === 'organize' ? 'organize' : action.type === 'flag' ? 'flag' : 'copy',
            });
            existingArchivePaths.add(finalArchivePath.toLowerCase());
          }
        } else {
          logger.warn({ filePath: event.filePath, error: result.error }, '执行归档动作失败');
        }

        processedEventIds.push(event.eventId);
      } catch (err) {
        logger.warn({ err, filePath: event.filePath }, '处理事件失败');
      }
    }

    this.options.store.markEventsProcessed(processedEventIds);
    this.options.store.markActionsProcessed(executedIds);

    await this.reconcileArchived(project);

    const allContextEntries = this.buildContextEntries(project.id);
    const hasFailure = processedEventIds.length < events.length;
    const scanStatus: 'success' | 'partial' | 'failed' = hasFailure
      ? processedEventIds.length === 0
        ? 'failed'
        : 'partial'
      : 'success';
    this.generateReports(project, allContextEntries, scanStatus);
  }

  private async handleUnlink(
    project: Project,
    filePath: string,
    existingBySource: Map<string, ReturnType<MetadataStore['listArchiveMetadataByProject']>[number]>,
    now: number
  ): Promise<void> {
    const entryId = makeEntryId(project.id, filePath);
    const existing = existingBySource.get(filePath);
    if (existing) {
      this.options.store.updateArchiveMetadataStatus(existing.entryId, 'orphaned');
      this.options.store.upsertEntry({
        id: existing.entryId,
        projectId: project.id,
        filePath,
        contentHash: '',
        status: 'orphaned',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      this.options.store.upsertEntry({
        id: entryId,
        projectId: project.id,
        filePath,
        contentHash: '',
        status: 'orphaned',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private async reconcileArchived(project: Project): Promise<void> {
    const now = Date.now();
    const archived = this.options.store.listArchiveMetadataByProject(project.id);

    for (const meta of archived) {
      if (meta.status === 'orphaned') continue;
      if (!existsSync(meta.sourcePath)) {
        this.options.store.updateArchiveMetadataStatus(meta.entryId, 'orphaned');
        this.options.store.upsertEntry({
          id: meta.entryId,
          projectId: project.id,
          filePath: meta.sourcePath,
          contentHash: meta.contentHash,
          status: 'orphaned',
          createdAt: meta.copiedAt,
          updatedAt: now,
        });
      }
    }
  }

  private async decideAction(
    filePath: string,
    content: string,
    classification: ClassificationResult,
    archivePath: string,
    existing: {
      entryId: string;
      archivePath: string;
      contentHash: string;
      status: 'active' | 'orphaned' | 'superseded';
      type: 'copy' | 'organize' | 'flag';
    } | null,
    suggest: SuggestionEngine
  ): Promise<ArchiveAction> {
    if (existing && existing.status === 'active' && existing.archivePath === archivePath) {
      return {
        id: makeActionId(filePath),
        sourcePath: filePath,
        type: 'ignore',
        reason: '文件已归档且分类未变化',
        targetPath: archivePath,
        risk: 'low',
        confidence: 0.95,
        createdAt: Date.now(),
      };
    }

    if (existing && existing.status === 'active' && existing.archivePath !== archivePath) {
      return {
        id: makeActionId(filePath),
        sourcePath: existing.archivePath,
        type: 'organize',
        reason: `分类变化，从 ${existing.archivePath} 重新组织到 ${archivePath}`,
        targetPath: archivePath,
        risk: 'low',
        confidence: 0.9,
        createdAt: Date.now(),
      };
    }

    return suggest.suggest(filePath, classification, {
      dedupRelation: 'unrelated',
      proposedArchivePath: archivePath,
      contentPreview: content.slice(0, 1000),
    });
  }

  private buildContextEntries(
    projectId: string
  ): Array<{
    filePath: string;
    archivePath: string;
    category: string;
    docType: string;
    summary: string;
    tags: string[];
    sections: Array<{ heading: string; summary: string; confidence: number }>;
    status: 'pending' | 'archived' | 'ignored' | 'orphaned';
    updatedAt: number;
  }> {
    const all = this.options.store.listArchiveMetadataByProject(projectId);
    return all.map((m) => ({
      filePath: m.sourcePath,
      archivePath: m.archivePath,
      category: m.category,
      docType: m.docType,
      summary: m.summary,
      tags: m.tags,
      sections: [],
      status: m.status === 'active' ? 'archived' : m.status === 'superseded' ? 'archived' : m.status,
      updatedAt: m.organizedAt ?? m.copiedAt,
    }));
  }

  private generateReports(
    project: Project,
    contextEntries: Array<{
      filePath: string;
      archivePath: string;
      category: string;
      docType: string;
      summary: string;
      tags: string[];
      sections: Array<{ heading: string; summary: string; confidence: number }>;
      status: 'pending' | 'archived' | 'ignored' | 'orphaned';
      updatedAt: number;
    }>,
    scanStatus: 'success' | 'partial' | 'failed'
  ): void {
    const archiveRoot = getArchiveRoot(project);
    const now = Date.now();

    generateContext({
      projectRoot: project.rootPath,
      archiveRoot,
      projectName: project.name,
      entries: contextEntries,
    });

    const allHistory = this.options.store.listActionHistory(project.id);
    writeSuggestions({ projectRoot: project.rootPath, archiveRoot, actions: allHistory });

    const counts = this.options.store.getProjectCounts(project.id);
    const status = buildProjectStatus({
      projectId: project.id,
      lastScannedAt: now,
      scanStatus,
      pendingCount: counts.pending,
      archivedCount: counts.archived,
      ignoredCount: counts.ignored,
      orphanedCount: counts.orphaned,
      copiedCount: counts.copied,
      organizedCount: counts.organized,
      flaggedCount: counts.flagged,
    });
    updateStatus({ archiveRoot, status });

    writeReadme({ archiveRoot });

    logger.info(
      { projectId: project.id, scanStatus: status.scanStatus, counts },
      '归档扫描完成'
    );
  }
}

function makeEntryId(projectId: string, filePath: string): string {
  return createHash('sha256').update(`${projectId}:${filePath}`).digest('hex').slice(0, 16);
}

function makeActionId(filePath: string): string {
  return createHash('sha256').update(`${filePath}:${Date.now()}`).digest('hex').slice(0, 16);
}
