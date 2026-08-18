import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArchiverProviderContextRequest,
  ArchiverProviderContextResult,
  ArchiverProviderDescriptor,
  ArchiverProviderOverride,
  ArchiverProviderQueryRequest,
  ArchiverProviderQueryResult,
  ArchiverProviderRuntime,
  ArchiverProviderSyncContext,
  ArchiverProviderSyncResult,
} from '../provider-types.js';
import { PYTHON_LAUNCH_ENVIRONMENT_KEYS, UV_LAUNCH_ENVIRONMENT_KEYS } from '../provider-launch.js';
import {
  capKnowledgeItems,
  scoreKnowledgeText,
  tokenizeKnowledgeQuery,
} from '../provider-query-utils.js';
import { CliProviderAdapter, formatShellFailure } from './cli-provider-adapter.js';

const MAX_GRAPH_BYTES = 128 * 1024 * 1024;

export class GraphifyProviderAdapter extends CliProviderAdapter {
  readonly descriptor: ArchiverProviderDescriptor = {
    id: 'graphify',
    displayName: 'Graphify',
    description: '基于 AST 构建代码结构图，为查询、影响分析和架构探索提供支撑。',
    homepage: 'https://github.com/Graphify-Labs/graphify',
    license: 'MIT',
    kind: 'cli',
    automation: 'full',
    placements: ['primary', 'fallback', 'enricher'],
    capabilities: ['code-structure', 'documents', 'query', 'impact-analysis'],
    autoSelect: true,
    selectionPriority: 100,
    defaultExecutable: 'graphify',
    defaultLaunchPreset: 'installed',
    managedRuntime: {
      kind: 'python-package',
      packageName: 'graphifyy',
      version: '0.9.42',
      entrypoint: 'graphify',
    },
    launchPresets: [
      {
        id: 'installed',
        displayName: '已安装命令',
        description: '使用 PATH 中已有的 graphify 命令。',
        executable: 'graphify',
        argsPrefix: [],
      },
      {
        id: 'uvx',
        displayName: 'uvx 临时运行',
        description: '通过 uvx --from graphifyy graphify 运行，首次使用可能下载包。',
        executable: 'uvx',
        argsPrefix: ['--from', 'graphifyy', 'graphify'],
        inheritEnv: [...UV_LAUNCH_ENVIRONMENT_KEYS],
      },
      {
        id: 'python-module',
        displayName: 'python -m',
        description: '使用当前 Python 环境中的 graphify 模块。',
        executable: 'python',
        argsPrefix: ['-m', 'graphify'],
        inheritEnv: [...PYTHON_LAUNCH_ENVIRONMENT_KEYS],
      },
    ],
    options: [
      {
        key: 'codeOnly',
        displayName: '仅索引代码',
        description:
          '推荐开启：代码结构完全本地处理，文档知识继续由内置 Archiver 提炼。关闭后 Graphify 可能需要额外模型凭据。',
        type: 'boolean',
        defaultValue: true,
      },
    ],
  };

  async sync(
    context: ArchiverProviderSyncContext,
    runtime: ArchiverProviderRuntime,
    override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderSyncResult> {
    const dataRoot = join(context.providerDataRoot, this.descriptor.id);
    const graphRoot = join(dataRoot, 'graphify-out');
    const graphPath = join(graphRoot, 'graph.json');
    await mkdir(dataRoot, { recursive: true });

    const initialized = existsSync(graphPath);
    const args = [
      'extract',
      context.project.rootPath,
      '--out',
      dataRoot,
      '--no-viz',
      '--no-cluster',
      ...(override?.options?.codeOnly === false ? [] : ['--code-only']),
    ];
    const result = await this.runCommand(context, runtime, override, {
      args,
      cwd: dataRoot,
      env: {
        GRAPHIFY_NO_TIPS: '1',
      },
      timeoutMs: 30 * 60 * 1000,
    });

    if (!result.success) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: formatShellFailure(result),
      };
    }
    return {
      providerId: this.descriptor.id,
      success: true,
      message: initialized ? 'Graphify 知识图谱已更新' : 'Graphify 知识图谱已创建',
      artifacts: [toArtifactPath(this.descriptor.id, 'graphify-out', 'graph.json')],
      metadata: { mode: initialized ? 'incremental-extract' : 'extract' },
    };
  }

  async loadContext(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    request: ArchiverProviderContextRequest,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderContextResult> {
    const outputRoot = this.getOutputRoot(context);
    const maxChars = request.maxChars ?? 8000;
    const report = await readOptionalText(join(outputRoot, 'GRAPH_REPORT.md'), maxChars);
    const wikiIndex = await readOptionalText(join(outputRoot, 'wiki', 'index.md'), maxChars);
    if (report || wikiIndex) {
      return {
        providerId: this.descriptor.id,
        success: true,
        content: capKnowledgeItems([report, wikiIndex], 2, maxChars).join('\n\n'),
      };
    }

    const graph = await this.readGraph(context);
    if (!graph) {
      return {
        providerId: this.descriptor.id,
        success: false,
        message: 'Graphify 图谱不存在或不可读取',
      };
    }
    return {
      providerId: this.descriptor.id,
      success: true,
      content: buildGraphSummary(graph, maxChars),
    };
  }

  async query(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    request: ArchiverProviderQueryRequest,
    _override?: ArchiverProviderOverride
  ): Promise<ArchiverProviderQueryResult> {
    const graph = await this.readGraph(context);
    if (!graph) {
      return {
        providerId: this.descriptor.id,
        success: false,
        items: [],
        message: 'Graphify 图谱不存在或不可读取',
      };
    }
    const tokens = tokenizeKnowledgeQuery(request.query);
    const adjacency = buildAdjacency(graph);
    const nodesById = new Map(
      graph.nodes.map(node => [normalizeNodeId(node.id), node] as const).filter(entry => entry[0])
    );
    const ranked = graph.nodes
      .map(node => {
        const nodeId = normalizeNodeId(node.id);
        const relations = nodeId ? (adjacency.get(nodeId) ?? []) : [];
        const text = [
          ...Object.values(node).map(formatScalar),
          ...relations.flatMap(relation => [relation.relation, relation.otherId]),
        ]
          .filter(Boolean)
          .join(' ');
        return {
          node,
          nodeId,
          relations,
          score: scoreKnowledgeText(text, tokens) + Math.log2(relations.length + 1),
        };
      })
      .filter(entry => tokens.length === 0 || entry.score > Math.log2(entry.relations.length + 1))
      .sort((left, right) => right.score - left.score);
    const items = ranked.map(entry => formatGraphNode(entry.node, entry.relations, nodesById));
    return {
      providerId: this.descriptor.id,
      success: true,
      items: capKnowledgeItems(items, request.limit ?? 6, request.maxChars ?? 10000),
    };
  }

  async isReady(
    context: ArchiverProviderSyncContext,
    _runtime: ArchiverProviderRuntime,
    _override?: ArchiverProviderOverride
  ): Promise<boolean> {
    return (await this.readGraph(context)) !== null;
  }

  private getOutputRoot(context: ArchiverProviderSyncContext): string {
    return join(context.providerDataRoot, this.descriptor.id, 'graphify-out');
  }

  private async readGraph(context: ArchiverProviderSyncContext): Promise<GraphifyGraph | null> {
    const graphPath = join(this.getOutputRoot(context), 'graph.json');
    try {
      const info = await stat(graphPath);
      if (!info.isFile() || info.size > MAX_GRAPH_BYTES) return null;
      const parsed = JSON.parse(await readFile(graphPath, 'utf8')) as Partial<GraphifyGraph>;
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.links)) return null;
      return { nodes: parsed.nodes, links: parsed.links };
    } catch {
      return null;
    }
  }
}

interface GraphifyNode extends Record<string, unknown> {
  id?: unknown;
  label?: unknown;
  file_type?: unknown;
  source_file?: unknown;
  source_location?: unknown;
}

interface GraphifyLink extends Record<string, unknown> {
  source?: unknown;
  target?: unknown;
  relation?: unknown;
  confidence?: unknown;
}

interface GraphifyGraph {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
}

interface GraphRelation {
  relation: string;
  otherId: string;
  direction: 'in' | 'out';
}

async function readOptionalText(path: string, maxChars: number): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim().slice(0, maxChars);
  } catch {
    return '';
  }
}

function buildGraphSummary(graph: GraphifyGraph, maxChars: number): string {
  const adjacency = buildAdjacency(graph);
  const topNodes = graph.nodes
    .map(node => ({ node, degree: adjacency.get(normalizeNodeId(node.id))?.length ?? 0 }))
    .sort((left, right) => right.degree - left.degree)
    .slice(0, 12)
    .map(({ node, degree }) => `${formatNodeLabel(node)}（关联 ${degree}）`);
  const sourceFiles = new Set(
    graph.nodes.map(node => formatScalar(node.source_file)).filter(Boolean)
  );
  return capKnowledgeItems(
    [
      `图谱节点 ${graph.nodes.length} 个，关系 ${graph.links.length} 条，来源文件 ${sourceFiles.size} 个。`,
      topNodes.length > 0 ? `高连接节点：${topNodes.join('、')}` : '',
    ],
    2,
    maxChars
  ).join('\n');
}

function buildAdjacency(graph: GraphifyGraph): Map<string, GraphRelation[]> {
  const adjacency = new Map<string, GraphRelation[]>();
  for (const link of graph.links) {
    const source = normalizeNodeId(link.source);
    const target = normalizeNodeId(link.target);
    if (!source || !target) continue;
    const relation = formatScalar(link.relation) || 'related';
    appendRelation(adjacency, source, { relation, otherId: target, direction: 'out' });
    appendRelation(adjacency, target, { relation, otherId: source, direction: 'in' });
  }
  return adjacency;
}

function appendRelation(
  adjacency: Map<string, GraphRelation[]>,
  nodeId: string,
  relation: GraphRelation
): void {
  const relations = adjacency.get(nodeId) ?? [];
  relations.push(relation);
  adjacency.set(nodeId, relations);
}

function formatGraphNode(
  node: GraphifyNode,
  relations: GraphRelation[],
  nodesById: Map<string, GraphifyNode>
): string {
  const type = formatScalar(node.file_type);
  const source = [formatScalar(node.source_file), formatScalar(node.source_location)]
    .filter(Boolean)
    .join(':');
  const relationText = relations
    .slice(0, 4)
    .map(relation => {
      const other = nodesById.get(relation.otherId);
      const arrow = relation.direction === 'out' ? '→' : '←';
      return `${relation.relation}${arrow}${other ? formatNodeLabel(other) : relation.otherId}`;
    })
    .join('，');
  return [formatNodeLabel(node), type ? `[${type}]` : '', source, relationText]
    .filter(Boolean)
    .join('；');
}

function formatNodeLabel(node: GraphifyNode): string {
  return formatScalar(node.label) || normalizeNodeId(node.id) || '未命名节点';
}

function normalizeNodeId(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    return normalizeNodeId((value as Record<string, unknown>).id);
  }
  return '';
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toArtifactPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/');
}
