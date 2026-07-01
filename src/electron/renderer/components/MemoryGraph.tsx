import { useEffect, useMemo, useRef, useState } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import { useTheme } from '../contexts/ThemeContext.js';
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from '../../shared/types.js';

const GROUP_KEYS = ['system', 'project', 'topic', 'episode', 'agent_case', 'agent_skill', 'profile', 'agent', 'user'] as const;
type GroupKey = (typeof GROUP_KEYS)[number];

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

/**
 * 从当前主题的 CSS 变量读取节点颜色。
 */
function readGraphColors(): Record<GroupKey, string> {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    system: get('--graph-node-system', '#4f46e5'),
    project: get('--graph-node-project', '#059669'),
    topic: get('--graph-node-topic', '#2563eb'),
    episode: get('--graph-node-episode', '#d97706'),
    agent_case: get('--graph-node-agent_case', '#15803d'),
    agent_skill: get('--graph-node-agent_skill', '#b45309'),
    profile: get('--graph-node-profile', '#db2777'),
    agent: get('--graph-node-agent', '#ea580c'),
    user: get('--graph-node-user', '#db2777'),
  };
}

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

interface MemoryGraphProps {
  graph: MemoryGraph;
  onNodeSelect?: (node: MemoryGraphNode) => void;
}

/**
 * 使用 vis-network 渲染力导向记忆图（EverOS 风格）
 */
export function MemoryGraph({ graph, onNodeSelect }: MemoryGraphProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef<DataSet<any> | null>(null);
  const graphRef = useRef(graph);
  const stableGraph = useMemo(() => {
    if (graphsEqual(graphRef.current, graph)) return graphRef.current;
    graphRef.current = graph;
    return graph;
  }, [graph]);
  const [activeGroups, setActiveGroups] = useState<Set<string>>(() => new Set(Object.keys(GROUP_LABELS)));
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node?: MemoryGraphNode } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const colors = readGraphColors();
    const style = getComputedStyle(document.documentElement);
    const textPrimary = style.getPropertyValue('--graph-text-primary').trim() || '#1f2937';
    const edgeColor = style.getPropertyValue('--graph-edge').trim() || '#9ca3af';
    const edgeHighlight = style.getPropertyValue('--graph-edge-highlight').trim() || '#2563eb';

    const nodes = new DataSet(
      stableGraph.nodes.map((n) => ({
        ...n,
        color: colors[n.group as GroupKey],
        hidden: !activeGroups.has(n.group),
      }))
    );
    nodesRef.current = nodes;
    const edges = new DataSet(stableGraph.edges.map((e, idx) => ({ ...e, id: e.id ?? `edge-${idx}` })));

    const network = new Network(
      containerRef.current,
      { nodes, edges },
      {
        nodes: {
          shape: 'dot',
          size: 18,
          font: { color: textPrimary, size: 13, face: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' },
          borderWidth: 2,
          shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 10, x: 0, y: 0 },
        },
        edges: {
          color: { color: edgeColor, highlight: edgeHighlight, hover: edgeHighlight },
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
        layout: { randomSeed: 2 },
      }
    );

    network.on('click', (params) => {
      if (params.nodes.length > 0 && onNodeSelect) {
        const nodeId = params.nodes[0] as string;
        const node = stableGraph.nodes.find((n) => n.id === nodeId);
        if (node) onNodeSelect(node);
      }
    });

    network.on('hoverNode', (params) => {
      const node = stableGraph.nodes.find((n) => n.id === params.node);
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

    networkRef.current = network;
    return () => {
      network.destroy();
      nodesRef.current = null;
    };
  }, [stableGraph, onNodeSelect, activeGroups]);

  /**
   * 主题变化时更新节点颜色与网络选项，不重建 Network。
   */
  useEffect(() => {
    const network = networkRef.current;
    const nodes = nodesRef.current;
    if (!network || !nodes) return;

    const colors = readGraphColors();
    const style = getComputedStyle(document.documentElement);
    const textPrimary = style.getPropertyValue('--graph-text-primary').trim() || '#1f2937';
    const edgeColor = style.getPropertyValue('--graph-edge').trim() || '#9ca3af';
    const edgeHighlight = style.getPropertyValue('--graph-edge-highlight').trim() || '#2563eb';

    nodes.forEach((node: any) => {
      nodes.update({ id: node.id, color: colors[node.group as GroupKey] });
    });

    network.setOptions({
      nodes: { font: { color: textPrimary } },
      edges: { color: { color: edgeColor, highlight: edgeHighlight, hover: edgeHighlight } },
    });
  }, [theme]);

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

  const colors = readGraphColors();

  return (
    <div className="memory-graph-canvas-wrap">
      <div className="memory-graph-bg" />
      <div ref={containerRef} className="memory-graph-canvas" />

      <div className="memory-graph-filter">
        <div className="memory-graph-filter-title">Filter by type</div>
        <div className="memory-graph-filter-chips">
          {Object.entries(colors).map(([group, color]) => (
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
            <span className="memory-graph-legend-dot" style={{ backgroundColor: colors[group as GroupKey] }} />
            {label}
          </div>
        ))}
      </div>

      <div className="memory-graph-zoom">
        <button className="memory-graph-zoom-btn" onClick={zoomIn} title="放大">+</button>
        <button className="memory-graph-zoom-btn" onClick={zoomOut} title="缩小">−</button>
        <button className="memory-graph-zoom-btn" onClick={fit} title="适配">⊡</button>
      </div>

      {tooltip?.node && (
        <div
          className="memory-graph-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span
            className="memory-graph-tooltip-type"
            style={{ backgroundColor: colors[tooltip.node.group as GroupKey], color: 'var(--graph-bg)' }}
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
