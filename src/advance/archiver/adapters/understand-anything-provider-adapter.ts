import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  ArchiverProviderAdapter,
  ArchiverProviderContextRequest,
  ArchiverProviderContextResult,
  ArchiverProviderDescriptor,
  ArchiverProviderOverride,
  ArchiverProviderPrepareResult,
  ArchiverProviderProbeResult,
  ArchiverProviderQueryRequest,
  ArchiverProviderQueryResult,
  ArchiverProviderRuntime,
  ArchiverProviderSyncContext,
  ArchiverProviderSyncResult,
} from '../provider-types.js';
import {
  capKnowledgeItems,
  scoreKnowledgeText,
  tokenizeKnowledgeQuery,
} from '../provider-query-utils.js';

const KNOWLEDGE_ROOT_NAMES = ['.understand-anything', '.ua'] as const;
const KNOWLEDGE_GRAPH_FILE_NAME = 'knowledge-graph.json';
const KNOWLEDGE_FILE_EXTENSIONS = new Set(['.json', '.md', '.txt', '.yaml', '.yml']);
const MAX_KNOWLEDGE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_KNOWLEDGE_FILES = 48;

export class UnderstandAnythingProviderAdapter implements ArchiverProviderAdapter {
  readonly descriptor: ArchiverProviderDescriptor = {
    id: 'understand-anything',
    displayName: 'Understand Anything',
    description: '交互式 Agent Skill，可按需生成项目理解文档和结构化知识。',
    homepage: 'https://github.com/Egonex-AI/Understand-Anything',
    license: 'MIT',
    kind: 'skill',
    automation: 'manual',
    placements: ['enricher'],
    capabilities: ['code-structure', 'documents', 'query', 'interactive-skill'],
    autoSelect: true,
    managedRuntime: {
      kind: 'git-skill',
      repository: 'https://github.com/Egonex-AI/Understand-Anything.git',
      revision: 'v2.9.0',
      version: '2.9.0',
      skillPath: 'understand-anything-plugin/skills/understand/SKILL.md',
    },
  };

  async prepare(
    _context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderPrepareResult> {
    if (!runtime.provisioner) {
      return {
        providerId: this.descriptor.id,
        success: false,
        prepared: false,
        manual: true,
        message: '系统未初始化 Provider 托管运行时',
      };
    }
    return runtime.provisioner.prepare(this.descriptor);
  }

  async probe(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderProbeResult> {
    if (await this.hasKnowledgeArtifacts(context)) {
      return {
        providerId: this.descriptor.id,
        available: true,
        readiness: 'ready',
        prepared: true,
        message: '已读取项目理解产物；Skill 仅用于重新生成',
      };
    }
    const prepared = await runtime.provisioner?.resolve(this.descriptor);
    if (prepared?.prepared) {
      return {
        providerId: this.descriptor.id,
        available: false,
        readiness: 'manual',
        prepared: true,
        version: prepared.version,
        message: 'Skill 已自动准备；执行阶段需要 Agent 工作流调度',
      };
    }
    return {
      providerId: this.descriptor.id,
      available: false,
      readiness: 'preparable',
      prepared: false,
      message: 'Skill 可由系统自动准备；运行阶段需要 Agent 工作流调度',
    };
  }

  async sync(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult> {
    return {
      providerId: this.descriptor.id,
      success: true,
      skipped: true,
      message: (await this.hasKnowledgeArtifacts(context))
        ? '项目理解产物已存在，等待下一次 Agent 工作流更新'
        : 'Skill 资源已准备，等待 Agent 工作流生成项目知识图谱',
    };
  }

  async isReady(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<boolean> {
    return this.hasKnowledgeArtifacts(context);
  }

  async loadContext(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    request: ArchiverProviderContextRequest,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderContextResult> {
    const documents = await this.readKnowledgeDocuments(context);
    if (documents.length === 0) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: '尚无项目理解产物',
      };
    }
    return {
      providerId: this.descriptor.id,
      success: true,
      content: capKnowledgeItems(
        documents.map(document => formatDocument(document.path, document.content)),
        documents.length,
        request.maxChars ?? 8000
      ).join('\n\n'),
    };
  }

  async query(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    request: ArchiverProviderQueryRequest,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderQueryResult> {
    const documents = await this.readKnowledgeDocuments(context);
    const tokens = tokenizeKnowledgeQuery(request.query);
    const ranked = documents
      .map(document => ({
        document,
        score: scoreKnowledgeText(`${document.path} ${document.content}`, tokens),
      }))
      .filter(entry => tokens.length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map(entry => formatDocument(entry.document.path, entry.document.content));
    return {
      providerId: this.descriptor.id,
      success: true,
      items: capKnowledgeItems(ranked, request.limit ?? 6, request.maxChars ?? 8000),
    };
  }

  private async hasKnowledgeArtifacts(context: ArchiverProviderSyncContext): Promise<boolean> {
    const root = await this.findKnowledgeRoot(context.project.rootPath);
    if (!root) return false;
    try {
      const graphPath = join(root, KNOWLEDGE_GRAPH_FILE_NAME);
      const graphStat = await stat(graphPath);
      return graphStat.isFile() && graphStat.size <= MAX_KNOWLEDGE_FILE_BYTES;
    } catch {
      return false;
    }
  }

  private async readKnowledgeDocuments(
    context: ArchiverProviderSyncContext
  ): Promise<Array<{ path: string; content: string }>> {
    const root = await this.findKnowledgeRoot(context.project.rootPath);
    if (!root) return [];
    const files = await collectKnowledgeFiles(root, MAX_KNOWLEDGE_FILES);
    const documents: Array<{ path: string; content: string }> = [];
    for (const file of files) {
      try {
        const fileStat = await stat(file);
        if (!fileStat.isFile() || fileStat.size > MAX_KNOWLEDGE_FILE_BYTES) continue;
        const content = (await readFile(file, 'utf8')).trim();
        if (!content) continue;
        documents.push({
          path: relative(context.project.rootPath, file).replace(/\\/g, '/'),
          content,
        });
      } catch {
        continue;
      }
    }
    return documents;
  }

  private async findKnowledgeRoot(projectRoot: string): Promise<string | null> {
    for (const name of KNOWLEDGE_ROOT_NAMES) {
      const candidate = join(projectRoot, name);
      try {
        if ((await stat(candidate)).isDirectory()) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }
}

async function collectKnowledgeFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < limit) {
    const current = pending.shift();
    if (!current) continue;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && KNOWLEDGE_FILE_EXTENSIONS.has(extensionOf(entry.name))) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index).toLowerCase() : '';
}

function formatDocument(path: string, content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const preview = normalized.length > 2400 ? `${normalized.slice(0, 2400)}…` : normalized;
  return `- ${path}: ${preview}`;
}
