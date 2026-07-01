import { useEffect, useRef, useState } from 'react';
import { Network } from 'vis-network';
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from '../../shared/types.js';

interface MemoryGraphProps {
  graph: MemoryGraph;
  onNodeSelect?: (node: MemoryGraphNode) => void;
}

const GROUP_COLORS: Record<string, string> = {
  system: '#d29922',
  project: '#a371f7',
  topic: '#58a6ff',
  episode: '#3fb950',
  agent_case: '#238636',
  agent_skill: '#d29922',
  profile: '#ff6b9d',
  agent: '#f78166',
  user: '#ff6b9d',
};

const GROUP_LABELS: Record<string, string> = {
  system: 'System',
  project: 'Project',
  topic: 'Topic',
  episode: 'Episode',
  agent_case: 'Case',
  agent_skill: 'Skill',
  profile: 'Profile',
  agent: 'Agent',
  user: 'User',
};

function edgeKey(e: MemoryGraphEdge): string {
  return `${e.from}>${e.to}|${e.label ?? ''}`;
}

function graphsEqual(a: MemoryGraph, b: MemoryGraph): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  const aNodeIds = a.nodes.map((n) => n.id).sort();
  const bNodeIds = b.nodes.map((n) => n.id).sort();
  for (let i = 0; i < aNodeIds.length; i++) {
    if (aNodeIds[i] !== bNodeIds[i]) return false;
  }
  const aEdges = a.edges.map(edgeKey).sort();
  const bEdges = b.edges.map(edgeKey).sort();
  for (let i = 0; i < aEdges.length; i++) {
    if (aEdges[i] !== bEdges[i]) return false;
  }
  return true;
}

/**
 * 使用 vis-network 渲染力导向记忆图（EverOS 风格）
 */
export function MemoryGraph({ graph, onNodeSelect }: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef<MemoryGraphNode[] | null>(null);
  const edgesRef = useRef<MemoryGraphEdge[] | null>(null);
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const lastGraphRef = useRef<MemoryGraph | null>(null);
  const [activeGroups, setActiveGroups] = useState<Set<string>>(() => new Set(Object.keys(GROUP_COLORS)));
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node?: MemoryGraphNode } | null>(null);
  const [debugInfo, setDebugInfo] = useState({ nodeCount: 0, width: 0, height: 0, networkCreated: false, positions: '', error: '' });

  // 仅在图谱结构真正变化时重建 Network，并保留已有节点位置
  useEffect(() => {
    if (!containerRef.current) return;
    if (lastGraphRef.current && graphsEqual(lastGraphRef.current, graph)) return;
    lastGraphRef.current = graph;

    // 销毁旧网络前记录位置
    if (networkRef.current) {
      try {
        positionsRef.current = networkRef.current.getPositions();
      } catch {
        // 旧网络未就绪时忽略
      }
      networkRef.current.destroy();
      networkRef.current = null;
      nodesRef.current = null;
      edgesRef.current = null;
    }

    const rect = containerRef.current.getBoundingClientRect();
    setDebugInfo((prev) => ({ ...prev, nodeCount: graph.nodes.length, width: rect.width, height: rect.height, error: '' }));

    const nodes = graph.nodes.map((n) => {
      const pos = positionsRef.current[n.id];
      return {
        ...n,
        color: GROUP_COLORS[n.group],
        hidden: !activeGroups.has(n.group),
        x: pos?.x,
        y: pos?.y,
      };
    });
    const edges = graph.edges.map((e, idx) => ({ ...e, id: e.id ?? `edge-${idx}` }));
    nodesRef.current = nodes;
    edgesRef.current = edges;

    let network: Network;
    try {
      network = new Network(
        containerRef.current,
        { nodes, edges },
        {
          nodes: {
            shape: 'dot',
            size: 18,
            font: { color: '#c9d1d9', size: 13, face: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' },
            borderWidth: 2,
            shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 10, x: 0, y: 0 },
          },
          edges: {
            color: { color: '#30363d', highlight: '#58a6ff', hover: '#58a6ff' },
            width: 1,
            smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
          },
          physics: {
            barnesHut: {
              gravitationalConstant: -4000,
              centralGravity: 0.3,
              springLength: 180,
              springConstant: 0.04,
              damping: 0.09,
            },
            stabilization: { iterations: 200 },
          },
          interaction: { hover: true, tooltipDelay: 200 },
        }
      );
    } catch (err) {
      setDebugInfo((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    networkRef.current = network;
    setDebugInfo((prev) => ({ ...prev, networkCreated: true }));

    // 初次稳定后关闭物理引擎，避免无意义的持续抖动，并适配视图
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
      network.fit({ animation: false });
    });

    // 第一次绘制后抓取前几个节点的坐标，用于排查节点是否被画到视野外
    network.once('afterDrawing', () => {
      const positions = network.getPositions();
      const posStr = graph.nodes
        .slice(0, 3)
        .map((n) => {
          const p = positions[n.id];
          return `${n.id}(${Math.round(p?.x ?? 0)},${Math.round(p?.y ?? 0)})`;
        })
        .join(' ');
      setDebugInfo((prev) => ({ ...prev, positions: posStr }));
    });

    network.on('click', (params) => {
      if (params.nodes.length > 0 && onNodeSelect) {
        const nodeId = params.nodes[0] as string;
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (node) onNodeSelect(node);
      }
    });

    network.on('hoverNode', (params) => {
      const node = graph.nodes.find((n) => n.id === params.node);
      if (!node) return;
      const domCoords = network.canvasToDOM(network.getPositions([params.node])[params.node]);
      const rect = containerRef.current!.getBoundingClientRect();
      setTooltip({
        x: domCoords.x + rect.left + 16,
        y: domCoords.y + rect.top + 16,
        node,
      });
    });

    network.on('blurNode', () => {
      setTooltip(null);
    });

    // 容器大小变化时重绘并适配，避免初始尺寸为 0 导致画布空白
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver((entries) => {
        const cr = entries[0].contentRect;
        setDebugInfo((prev) => ({ ...prev, width: cr.width, height: cr.height }));
        network.redraw();
        network.fit({ animation: false });
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      try {
        positionsRef.current = network.getPositions();
      } catch {
        // ignore
      }
      if (resizeObserver) resizeObserver.disconnect();
      network.destroy();
    };
  }, [graph, onNodeSelect]);

  // 类型过滤不重建网络，仅更新 hidden 属性
  useEffect(() => {
    if (!networkRef.current || !nodesRef.current || !edgesRef.current) return;
    const nodes = nodesRef.current.map((n) => ({
      ...n,
      hidden: !activeGroups.has(n.group),
    }));
    networkRef.current.setData({ nodes, edges: edgesRef.current });
  }, [activeGroups, graph.nodes]);

  const toggleGroup = (group: string) => {
    setActiveGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const zoomIn = () => networkRef.current?.moveTo({ scale: (networkRef.current.getScale() ?? 1) * 1.2 });
  const zoomOut = () => networkRef.current?.moveTo({ scale: (networkRef.current.getScale() ?? 1) / 1.2 });
  const fit = () => networkRef.current?.fit({ animation: true });

  return (
    <div className="memory-graph-canvas-wrap">
      <div className="memory-graph-bg" />
      <div ref={containerRef} className="memory-graph-canvas" />

      <div className="memory-graph-filter">
        <div className="memory-graph-filter-title">Filter by type</div>
        <div className="memory-graph-filter-chips">
          {Object.entries(GROUP_COLORS).map(([group, color]) => (
            <button
              key={group}
              className={`memory-graph-filter-chip${activeGroups.has(group) ? ' active' : ''}`}
              style={{ borderColor: color, color }}
              onClick={() => toggleGroup(group)}
            >
              <span className="memory-graph-chip-dot" style={{ backgroundColor: color }} />
              {GROUP_LABELS[group]}
            </button>
          ))}
        </div>
      </div>

      <div className="memory-graph-legend">
        {Object.entries(GROUP_LABELS).map(([group, label]) => (
          <div key={group} className="memory-graph-legend-item">
            <span className="memory-graph-legend-dot" style={{ backgroundColor: GROUP_COLORS[group] }} />
            {label}
          </div>
        ))}
      </div>

      <div className="memory-graph-zoom">
        <button className="memory-graph-zoom-btn" onClick={zoomIn} title="放大">+</button>
        <button className="memory-graph-zoom-btn" onClick={zoomOut} title="缩小">−</button>
        <button className="memory-graph-zoom-btn" onClick={fit} title="适配">⊡</button>
      </div>

      <div className="memory-graph-debug">
        nodes: {debugInfo.nodeCount} | canvas: {Math.round(debugInfo.width)}×{Math.round(debugInfo.height)} | network: {debugInfo.networkCreated ? 'yes' : 'no'}
        <br />
        pos: {debugInfo.positions || 'pending'}
        {debugInfo.error && <><br />err: {debugInfo.error}</>}
      </div>

      {tooltip?.node && (
        <div
          className="memory-graph-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span
            className="memory-graph-tooltip-type"
            style={{ backgroundColor: GROUP_COLORS[tooltip.node.group], color: '#0d1117' }}
          >
            {GROUP_LABELS[tooltip.node.group]}
          </span>
          <h3>{tooltip.node.label}</h3>
          {tooltip.node.title && <p>{tooltip.node.title}</p>}
          {tooltip.node.details && <p>{tooltip.node.details.slice(0, 200)}</p>}
          <div className="memory-graph-tooltip-meta">
            {tooltip.node.projectId && <span>项目: {tooltip.node.projectId}</span>}
            {tooltip.node.timestamp && <span>{tooltip.node.timestamp}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
