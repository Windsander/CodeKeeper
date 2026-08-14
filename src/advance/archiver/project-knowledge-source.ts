import type { Role, Project } from '../types.js';
import { getArchiveRoot } from '../types.js';
import type { ArchiverProviderCoordinator } from './provider-orchestrator.js';
import { createArchiverProviderCoordinator } from './codegraph-client.js';

export interface ProjectKnowledgeQueryOptions {
  role?: Role;
  limit?: number;
  maxChars?: number;
}

/** Reviewer、Maintainer 依赖的项目知识最小接口。 */
export interface ProjectKnowledgeSource {
  isAvailable(): Promise<boolean>;
  loadContext(maxChars?: number): Promise<string>;
  query(query: string, options?: ProjectKnowledgeQueryOptions): Promise<string[]>;
}

export interface ArchiverProjectKnowledgeSourceOptions {
  project: Project;
  orchestrator?: ArchiverProviderCoordinator;
}

/** 将 Archiver Provider 组合适配为角色无关的项目知识源。 */
export class ArchiverProjectKnowledgeSource implements ProjectKnowledgeSource {
  private readonly project: Project;
  private readonly archiveRoot: string;
  private readonly orchestrator: ArchiverProviderCoordinator;

  constructor(options: ArchiverProjectKnowledgeSourceOptions) {
    this.project = options.project;
    this.archiveRoot = getArchiveRoot(options.project);
    this.orchestrator = options.orchestrator ?? createArchiverProviderCoordinator();
  }

  isAvailable(): Promise<boolean> {
    return this.orchestrator.hasProjectKnowledgeSource(
      this.project,
      this.archiveRoot,
      this.orchestrator.getAutomaticStrategy()
    );
  }

  loadContext(maxChars = 8000): Promise<string> {
    return this.orchestrator.loadProjectKnowledgeContext(
      this.project,
      this.archiveRoot,
      this.orchestrator.getAutomaticStrategy(),
      { maxChars }
    );
  }

  query(query: string, options: ProjectKnowledgeQueryOptions = {}): Promise<string[]> {
    return this.orchestrator.queryProjectKnowledge(
      this.project,
      this.archiveRoot,
      this.orchestrator.getAutomaticStrategy(),
      {
        query,
        role: options.role,
        limit: options.limit,
        maxChars: options.maxChars,
      }
    );
  }
}

/** 合并旧 context.md 与 Provider 上下文，并保留清晰来源边界。 */
export function mergeProjectKnowledgeContext(
  legacyContext: string,
  providerContext: string
): string {
  const sections = [legacyContext.trim(), providerContext.trim()].filter(Boolean);
  return sections.join('\n\n');
}
