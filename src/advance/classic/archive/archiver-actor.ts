import type { IMemoryClient, ProjectKnowledgeItem } from '../memory/types.js';

export interface ArchiverActorOptions {
  memoryClient: IMemoryClient;
}

/**
 * Archiver 执行层：把提炼的项目知识写入记忆
 */
export class ArchiverActor {
  constructor(private readonly options: ArchiverActorOptions) {}

  async storeKnowledge(items: ProjectKnowledgeItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.options.memoryClient.recordProjectKnowledge(items);
  }
}
