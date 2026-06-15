import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ArchiveExecutor } from '../archive/archive-executor';
import { DocumentClassifier } from '../archive/classifier';
import { DedupDetector } from '../archive/dedup-detector';
import { parseDocument } from '../archive/document-parser';
import { SuggestionEngine } from '../archive/suggestion-engine';
import { generateContext } from '../codekeeper/context-generator';
import { updateStatus, buildProjectStatus } from '../codekeeper/status-updater';
import { writeSuggestions } from '../codekeeper/suggestions-writer';
import { writeReadme } from '../codekeeper/readme-writer';
import type { LlmClient } from '../llm/client';
import type { MetadataStore } from '../store/metadata-store';
import type { Project, ArchiveAction } from '../types';
import { loadProjectConfig } from '../config/project-config';
import { logger } from '../../core/logger';

export interface ArchivePipelineOptions {
  store: MetadataStore;
  client: LlmClient;
  /** 最大处理事件数，默认 50 */
  maxEvents?: number;
  /** 自动执行的风险等级 */
  autoRiskLevels?: ArchiveAction['risk'][];
}

/**
 * 归档管道：编排分类、去重、建议、执行与文件生成
 */
export class ArchivePipeline {
  private options: Required<Pick<ArchivePipelineOptions, 'maxEvents' | 'autoRiskLevels'>> &
    Omit<ArchivePipelineOptions, 'maxEvents' | 'autoRiskLevels'>;

  constructor(options: ArchivePipelineOptions) {
    this.options = {
      ...options,
      maxEvents: options.maxEvents ?? 50,
      autoRiskLevels: options.autoRiskLevels ?? ['low'],
    };
  }

  async run(project: Project): Promise<void> {
    const events = this.options.store.listPendingEvents(this.options.maxEvents);
    if (events.length === 0) return;

    const now = Date.now();

    const config = loadProjectConfig(project.rootPath);
    const classifier = new DocumentClassifier(this.options.client, {
      categories: config.categories.length > 0 ? config.categories : undefined,
      docTypes: config.docTypes.length > 0 ? config.docTypes : undefined,
    });
    const dedup = new DedupDetector(this.options.client);
    const suggest = new SuggestionEngine(this.options.client);
    const executor = new ArchiveExecutor({ projectRoot: project.rootPath, autoRiskLevels: this.options.autoRiskLevels });

    const existing = this.options.store.listEntriesByProject(project.id);
    const processedEventIds: number[] = [];
    const executedIds: string[] = [];
    const contextEntries: Array<{
      filePath: string;
      category: string;
      docType: string;
      summary: string;
      tags: string[];
      sections: Array<{ heading: string; summary: string; confidence: number }>;
      status: 'pending' | 'archived' | 'ignored';
      updatedAt: number;
    }> = [];

    for (const event of events) {
      try {
        const doc = parseDocument(event.filePath);
        const entryId = makeEntryId(project.id, event.filePath);
        const classification = await classifier.classify(event.filePath, doc.content);

        const dedupResult = await dedup.detect(
          { filePath: event.filePath, contentHash: doc.contentHash, content: doc.content },
          existing.map((e) => ({ filePath: e.filePath, contentHash: e.contentHash, content: readExistingContent(e.filePath) }))
        );

        const action = await suggest.suggest(event.filePath, doc.content, classification, {
          dedupRelation: dedupResult.relation,
          relatedPath: dedupResult.relatedPath,
        });

        this.options.store.insertAction({ ...action, projectId: project.id });

        const result = await executor.execute(action);
        if (result.success && result.finalPath) {
          executedIds.push(action.id);
          this.options.store.insertActionHistory({ ...action, projectId: project.id });
          this.options.store.upsertEntry({
            id: makeEntryId(project.id, result.finalPath),
            projectId: project.id,
            filePath: result.finalPath,
            contentHash: doc.contentHash,
            status: action.type === 'ignore' ? 'ignored' : 'archived',
            createdAt: now,
            updatedAt: now,
          });
          contextEntries.push({
            filePath: result.finalPath,
            category: classification.category,
            docType: classification.docType,
            summary: classification.summary,
            tags: classification.tags,
            sections: classification.sections,
            status: action.type === 'ignore' ? 'ignored' : 'archived',
            updatedAt: now,
          });
        } else {
          this.options.store.upsertEntry({
            id: entryId,
            projectId: project.id,
            filePath: event.filePath,
            contentHash: doc.contentHash,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          });
        }
        processedEventIds.push(event.eventId);
      } catch (err) {
        // 单条事件失败不应阻塞后续事件，失败事件保留在 watch_events 中供下次重试
        const entryId = makeEntryId(project.id, event.filePath);
        let contentHash = '';
        try {
          const doc = parseDocument(event.filePath);
          contentHash = doc.contentHash;
        } catch {
          // doc 解析失败时 contentHash 留空
        }
        this.options.store.upsertEntry({
          id: entryId,
          projectId: project.id,
          filePath: event.filePath,
          contentHash,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
        logger.warn({ err, filePath: event.filePath }, '处理事件失败');
      }
    }

    this.options.store.markEventsProcessed(processedEventIds);
    this.options.store.markActionsProcessed(executedIds);

    // 生成 .codekeeper/ 文件
    generateContext({
      projectRoot: project.rootPath,
      projectName: project.name,
      entries: contextEntries,
    });

    const allPending = this.options.store.listPendingActions(project.id);
    writeSuggestions({ projectRoot: project.rootPath, actions: allPending });

    const counts = this.options.store.getProjectCounts(project.id);
    const hasFailure = processedEventIds.length < events.length;
    const scanStatus: 'success' | 'partial' | 'failed' = hasFailure
      ? processedEventIds.length === 0
        ? 'failed'
        : 'partial'
      : 'success';
    const status = buildProjectStatus({
      projectId: project.id,
      lastScannedAt: now,
      scanStatus,
      pendingCount: counts.pending,
      archivedCount: counts.archived,
      ignoredCount: counts.ignored,
      suggestionCount: allPending.length,
    });
    updateStatus({ projectRoot: project.rootPath, status });

    // 生成 README 说明
    writeReadme({ projectRoot: project.rootPath });
  }
}

function makeEntryId(projectId: string, filePath: string): string {
  return createHash('sha256').update(`${projectId}:${filePath}`).digest('hex').slice(0, 16);
}

function readExistingContent(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
