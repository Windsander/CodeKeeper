import { useEffect, useMemo, useRef } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import type { PipelineDefinitionDto, PipelineNodeDto, PipelineRunDto } from '../../shared/types.js';

/** 节点类型分组 → 展示色与形状 */
const TYPE_STYLES: Record<string, { color: string; shape: string }> = {
  trigger: { color: '#f59e0b', shape: 'diamond' },
  role: { color: '#4f46e5', shape: 'box' },
  agent: { color: '#0d9488', shape: 'box' },
  knowledge: { color: '#059669', shape: 'ellipse' },
  sink: { color: '#64748b', shape: 'triangleDown' },
  default: { color: '#8b5cf6', shape: 'box' },
};

/** stage 状态 → 节点边框色（运行状态叠加） */
const STATUS_BORDER: Record<string, string> = {
  running: '#f59e0b',
  succeeded: '#22c55e',
  failed: '#ef4444',
  skipped: '#94a3b8',
};

function typeGroup(type: string): string {
  return type.split('.')[0] || 'default';
}

/** 最近一轮运行中各节点的状态（nodeId → status） */
export function latestStageStatus(runs: PipelineRunDto[]): Map<string, string> {
  const map = new Map<string, string>();
  const latest = runs[0];
  if (!latest) return map;
  for (const stage of latest.stages) {
    map.set(stage.nodeId, stage.status);
  }
  return map;
}

/** 结构签名：仅当节点集合/边连接关系/布局模式变化时才需要重建 Network */
function structureSignature(definition: PipelineDefinitionDto): string {
  return JSON.stringify({
    nodes: definition.nodes.map(node => `${node.id}:${node.type}`).sort(),
    edges: definition.edges
      .map(edge => `${edge.from.node}.${edge.from.port}->${edge.to.node}.${edge.to.port}`)
      .sort(),
    // 全部节点有坐标 → 自由布局；坐标值本身的变化不重建（呈现效应原地更新）
    freeLayout: definition.nodes.every(node => node.position),
  });
}

function toVisNode(node: PipelineNodeDto, status: string | undefined) {
  const group = TYPE_STYLES[typeGroup(node.type)] ?? TYPE_STYLES.default;
  return {
    id: node.id,
    label: `${node.label ?? node.id}\n${node.type}`,
    color: {
      background: group.color,
      border: status ? (STATUS_BORDER[status] ?? group.color) : group.color,
    },
    borderWidth: status ? 4 : 1,
    shape: group.shape as never,
    font: { color: '#ffffff' },
    ...(node.position ? { x: node.position.x, y: node.position.y } : {}),
  };
}

interface PipelineGraphProps {
  definition: PipelineDefinitionDto;
  runs: PipelineRunDto[];
  /** 选中节点时回调（null = 取消选中） */
  onSelectNode: (nodeId: string | null) => void;
  /** 拖拽结束：固化全部节点坐标（一次性转入自由布局，避免部分有坐标导致弹回） */
  onMoveAllNodes: (positions: Record<string, { x: number; y: number }>) => void;
  /** 新增连线（from/to 节点 id；端口映射由父组件负责） */
  onAddEdge: (fromNodeId: string, toNodeId: string) => void;
  onDeleteNodes: (nodeIds: string[]) => void;
  onDeleteEdges: (edgeIds: string[]) => void;
}

/**
 * 管线画布：vis-network 渲染定义图，叠加最近运行状态。
 *
 * 生命周期策略（避免轮询/检查器编辑把画布整个拆掉）：
 * - 结构效应：仅节点/边连接关系变化时重建 Network
 * - 呈现效应：label/位置/运行状态变化时 DataSet 原地更新，缩放平移与选中态保持
 */
export function PipelineGraph({
  definition,
  runs,
  onSelectNode,
  onMoveAllNodes,
  onAddEdge,
  onDeleteNodes,
  onDeleteEdges,
}: PipelineGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesDataRef = useRef<DataSet<object> | null>(null);
  const statusMap = useMemo(() => latestStageStatus(runs), [runs]);
  const signature = structureSignature(definition);

  // 结构效应：仅当连接关系变化时重建
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const nodes = new DataSet(
      definition.nodes.map(node => toVisNode(node, statusMap.get(node.id)))
    );
    nodesDataRef.current = nodes;
    const edges = new DataSet(
      definition.edges.map((edge, index) => ({
        id: edge.id ?? `edge-${index}`,
        from: edge.from.node,
        to: edge.to.node,
        label: edge.channel === 'memory' ? (edge.artifactType ?? '') : edge.channel,
        dashes: edge.channel !== 'memory',
        arrows: 'to' as const,
      }))
    );

    const hasPositions = definition.nodes.every(node => node.position);
    const network = new Network(
      containerRef.current,
      { nodes, edges },
      {
        layout: hasPositions
          ? { improvedLayout: false }
          : { hierarchical: { enabled: true, direction: 'LR', sortMethod: 'directed' } },
        physics: { enabled: false },
        interaction: { multiselect: true },
        manipulation: {
          enabled: true,
          addNode: false,
          editNode: false,
          // 不直接改 DataSet：上抛给父组件更新定义，由状态重建图
          addEdge: (
            edgeData: { from?: string | number; to?: string | number },
            callback: (data?: unknown) => void
          ) => {
            if (edgeData.from != null && edgeData.to != null) {
              onAddEdge(String(edgeData.from), String(edgeData.to));
            }
            // 故意不调用 callback(edgeData)：定义状态重建会覆盖
            void callback;
          },
          deleteNode: (
            data: { nodes?: Array<string | number> },
            callback: (data?: unknown) => void
          ) => {
            if (data.nodes?.length) onDeleteNodes(data.nodes.map(String));
            void callback;
          },
          deleteEdge: (
            data: { edges?: Array<string | number> },
            callback: (data?: unknown) => void
          ) => {
            if (data.edges?.length) onDeleteEdges(data.edges.map(String));
            void callback;
          },
        },
      }
    );
    networkRef.current = network;

    network.on('selectNode', params => {
      onSelectNode(params.nodes[0] != null ? String(params.nodes[0]) : null);
    });
    network.on('deselectNode', () => onSelectNode(null));
    network.on('dragEnd', params => {
      if (!params.nodes?.length) return;
      // 一次性固化全部节点坐标：部分节点无坐标会导致层级布局把被拖节点弹回
      const all = network.getPositions();
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [nodeId, pos] of Object.entries(all)) {
        positions[nodeId] = { x: Math.round(pos.x), y: Math.round(pos.y) };
      }
      onMoveAllNodes(positions);
    });

    return () => {
      network.destroy();
      networkRef.current = null;
      nodesDataRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // 呈现效应：label/坐标/运行状态原地更新，不打断缩放与选中态
  useEffect(() => {
    const nodesData = nodesDataRef.current;
    if (!nodesData) return;
    nodesData.update(definition.nodes.map(node => toVisNode(node, statusMap.get(node.id))));
  }, [definition, statusMap]);

  return <div ref={containerRef} className="pipeline-graph-canvas" />;
}
