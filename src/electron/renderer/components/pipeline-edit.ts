import type { PipelineDefinitionDto, PipelineNodeDto } from '../../shared/types.js';

/** 可经画布新增的节点类型（仅限 daemon 当前可执行的类型） */
export const NODE_PALETTE: Array<{ type: string; label: string }> = [
  { type: 'trigger.cron', label: '定时触发器' },
  { type: 'role.reviewer', label: 'Reviewer 角色' },
  { type: 'role.maintainer', label: 'Maintainer 角色' },
  { type: 'role.archiver', label: 'Archiver 角色' },
  { type: 'knowledge.project', label: '知识投影' },
  { type: 'knowledge.distill', label: '知识蒸馏' },
];

/** 新增连线的默认端口映射 */
export function defaultOutPort(type: string | undefined): string {
  return type === 'trigger.cron' ? 'tick' : 'out';
}
export function defaultInPort(type: string | undefined): string {
  return type?.startsWith('role.') ? 'trigger' : 'in';
}

/** 新增连线；重复连接（同 from/to 端口）时幂等返回原定义 */
export function addEdgeToDefinition(
  def: PipelineDefinitionDto,
  fromNodeId: string,
  toNodeId: string
): PipelineDefinitionDto {
  const fromNode = def.nodes.find(node => node.id === fromNodeId);
  const toNode = def.nodes.find(node => node.id === toNodeId);
  if (!fromNode || !toNode) return def;
  const fromPort = defaultOutPort(fromNode.type);
  const toPort = defaultInPort(toNode.type);
  const exists = def.edges.some(
    edge =>
      edge.from.node === fromNodeId &&
      edge.from.port === fromPort &&
      edge.to.node === toNodeId &&
      edge.to.port === toPort
  );
  if (exists) return def;
  return {
    ...def,
    edges: [
      ...def.edges,
      {
        id: `edge-${Date.now()}`,
        from: { node: fromNodeId, port: fromPort },
        to: { node: toNodeId, port: toPort },
        channel: 'memory' as const,
      },
    ],
  };
}

/** 删除节点及其关联边 */
export function deleteNodesFromDefinition(
  def: PipelineDefinitionDto,
  nodeIds: string[]
): PipelineDefinitionDto {
  return {
    ...def,
    nodes: def.nodes.filter(node => !nodeIds.includes(node.id)),
    edges: def.edges.filter(
      edge => !nodeIds.includes(edge.from.node) && !nodeIds.includes(edge.to.node)
    ),
  };
}

/** 删除边（edge.id 缺省时按渲染序 edge-${index} 匹配，与画布 id 生成一致） */
export function deleteEdgesFromDefinition(
  def: PipelineDefinitionDto,
  edgeIds: string[]
): PipelineDefinitionDto {
  return {
    ...def,
    edges: def.edges.filter((edge, index) => !edgeIds.includes(edge.id ?? `edge-${index}`)),
  };
}

/** 新增节点（无位置，交由分层布局）；id 带随机后缀避免同毫秒连点碰撞 */
export function addNodeToDefinition(
  def: PipelineDefinitionDto,
  type: string,
  label: string
): PipelineDefinitionDto {
  const nodeId = `${type.replace('.', '-')}-${crypto.randomUUID().slice(0, 8)}`;
  return {
    ...def,
    nodes: [...def.nodes, { id: nodeId, type, label, params: {} }],
  };
}

/** 更新节点（检查器编辑） */
export function updateNodeInDefinition(
  def: PipelineDefinitionDto,
  updated: PipelineNodeDto
): PipelineDefinitionDto {
  return {
    ...def,
    nodes: def.nodes.map(node => (node.id === updated.id ? updated : node)),
  };
}

/** 持久化全部节点坐标（拖拽结束时一次性固化，避免部分有坐标导致层级布局弹回） */
export function moveAllNodesInDefinition(
  def: PipelineDefinitionDto,
  positions: Record<string, { x: number; y: number }>
): PipelineDefinitionDto {
  return {
    ...def,
    nodes: def.nodes.map(node =>
      positions[node.id] ? { ...node, position: positions[node.id] } : node
    ),
  };
}

// ===== 钻取层（M7）=====

/** 沿钻取路径取当前视图定义（路径为空返回根定义） */
export function getDrillDefinition(
  root: PipelineDefinitionDto,
  drillPath: string[]
): PipelineDefinitionDto | null {
  let current: PipelineDefinitionDto = root;
  for (const nodeId of drillPath) {
    const node = current.nodes.find(n => n.id === nodeId);
    if (!node?.subgraph) return null;
    current = node.subgraph;
  }
  return current;
}

/** 沿钻取路径更新子图定义（返回新的根定义） */
export function updateDrillDefinition(
  root: PipelineDefinitionDto,
  drillPath: string[],
  updated: PipelineDefinitionDto
): PipelineDefinitionDto {
  if (drillPath.length === 0) return updated;
  const [head, ...rest] = drillPath;
  return {
    ...root,
    nodes: root.nodes.map(node =>
      node.id === head && node.subgraph
        ? { ...node, subgraph: updateDrillDefinition(node.subgraph, rest, updated) }
        : node
    ),
  };
}

/**
 * 为角色节点生成默认子图（"展开为子图"）：
 * 单个复合 stage（stage.role-run）包装既有 Runner 黑箱，行为与现状完全一致；
 * reviewer 额外附带 advisory 的 ast-grep 预检 stage。
 */
export function materializeRoleSubgraph(
  roleNodeId: string,
  roleType: string
): PipelineDefinitionDto {
  const nodes: PipelineDefinitionDto['nodes'] = [];
  const edges: PipelineDefinitionDto['edges'] = [];

  if (roleType === 'role.reviewer') {
    nodes.push({
      id: 'ast-grep-precheck',
      type: 'stage.ast-grep',
      label: 'ast-grep 预检',
      params: { paths: [] },
    });
    nodes.push({
      id: 'review-run',
      type: 'stage.role-run',
      label: '评审执行（复合）',
      params: {},
    });
    edges.push({
      from: { node: 'ast-grep-precheck', port: 'precheck' },
      to: { node: 'review-run', port: 'in' },
      channel: 'memory',
      artifactType: 'PrecheckResult',
    });
  } else {
    nodes.push({
      id: 'role-run',
      type: 'stage.role-run',
      label: '角色执行（复合）',
      params: {},
    });
  }

  return {
    version: 1,
    id: `${roleNodeId}-subgraph`,
    label: `${roleType} 内部 stage 子图`,
    nodes,
    edges,
  };
}
