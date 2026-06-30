import { useEffect, useRef, useState } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import type { MemoryGraph, MemoryGraphNode } from '../../shared/types.js';

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

/**
 * 使用 vis-network 渲染力导向记忆图
 */
export function MemoryGraph({ graph, onNodeSelect }: MemoryGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const [activeGroups, setActiveGroups] = useState<Set<string>>(() => new Set(Object.keys(GROUP_COLORS)));

  useEffect(() => {
    if (!containerRef.current) return;

    const nodes = new DataSet(
      graph.nodes.map((n) => ({
        ...n,
        color: GROUP_COLORS[n.group],
        hidden: !activeGroups.has(n.group),
      }))
    );
    const edges = new DataSet(graph.edges.map((e, idx) => ({ ...e, id: e.id ?? `edge-${idx}` })));

    const network = new Network(
      containerRef.current,
      { nodes, edges },
      {
        nodes: { shape: 'dot', size: 18, font: { color: '#c9d1d9', size: 13 } },
        edges: { color: '#30363d', smooth: { enabled: true, type: 'continuous', roundness: 0.5 } },
        physics: { barnesHut: { gravitationalConstant: -3000, springLength: 160 } },
        interaction: { hover: true },
      }
    );

    network.on('click', (params) => {
      if (params.nodes.length > 0 && onNodeSelect) {
        const nodeId = params.nodes[0] as string;
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (node) onNodeSelect(node);
      }
    });

    networkRef.current = network;
    return () => network.destroy();
  }, [graph, onNodeSelect, activeGroups]);

  const toggleGroup = (group: string) => {
    setActiveGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  return (
    <div className="memory-graph">
      <div className="memory-graph-filters">
        {Object.entries(GROUP_COLORS).map(([group, color]) => (
          <button
            key={group}
            className={`filter-chip${activeGroups.has(group) ? ' active' : ''}`}
            style={{ color, borderColor: color }}
            onClick={() => toggleGroup(group)}
          >
            {group}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="memory-graph-canvas" />
    </div>
  );
}
