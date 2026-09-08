/**
 * 管线图拓扑工具：校验与拓扑排序。
 */

import type { EdgeDef, NodeDef, PipelineDefinition } from './types.js';
import { PipelineCycleError, PipelineDefinitionError } from './types.js';

/**
 * 校验图结构：节点 id 唯一、边的端点引用存在的节点。
 * 抛出 PipelineDefinitionError（聚合全部问题）。
 */
export function validateGraph(def: PipelineDefinition): void {
  const issues: string[] = [];
  const nodeIds = new Set<string>();

  for (const node of def.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push(`节点 id 重复: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  for (const edge of def.edges) {
    if (!nodeIds.has(edge.from.node)) {
      issues.push(`边 ${describeEdge(edge)} 的起点节点不存在: ${edge.from.node}`);
    }
    if (!nodeIds.has(edge.to.node)) {
      issues.push(`边 ${describeEdge(edge)} 的终点节点不存在: ${edge.to.node}`);
    }
  }

  if (issues.length > 0) {
    throw new PipelineDefinitionError('管线定义校验失败', issues);
  }
}

/** 拓扑排序（Kahn）。有环时抛出 PipelineCycleError。 */
export function topoSort(def: PipelineDefinition): NodeDef[] {
  validateGraph(def);

  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const node of def.nodes) {
    indegree.set(node.id, 0);
  }
  for (const edge of def.edges) {
    if (edge.from.node === edge.to.node) {
      throw new PipelineCycleError([edge.from.node]);
    }
    indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
    downstream.set(edge.from.node, [...(downstream.get(edge.from.node) ?? []), edge.to.node]);
  }

  const queue = def.nodes.filter(node => (indegree.get(node.id) ?? 0) === 0).map(node => node.id);
  const ordered: NodeDef[] = [];
  const byId = new Map(def.nodes.map(node => [node.id, node]));

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = byId.get(id);
    if (!node) continue;
    ordered.push(node);
    for (const next of downstream.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (ordered.length !== def.nodes.length) {
    const inCycle = def.nodes.filter(node => (indegree.get(node.id) ?? 0) > 0).map(node => node.id);
    throw new PipelineCycleError(inCycle);
  }

  return ordered;
}

function describeEdge(edge: EdgeDef): string {
  return edge.id ?? `${edge.from.node}.${edge.from.port} -> ${edge.to.node}.${edge.to.port}`;
}
