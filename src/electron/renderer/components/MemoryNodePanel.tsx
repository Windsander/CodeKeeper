import { useMemo } from 'react';
import type { MemoryGraph, MemoryGraphNode } from '../../shared/types.js';

interface MemoryNodePanelProps {
  node: MemoryGraphNode;
  graph: MemoryGraph;
  onClose: () => void;
  onNodeClick?: (node: MemoryGraphNode) => void;
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

/**
 * 节点详情侧面板（EverOS 风格）
 */
export function MemoryNodePanel({ node, graph, onClose, onNodeClick }: MemoryNodePanelProps) {
  const connections = useMemo(() => {
    return graph.edges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => {
        const otherId = e.from === node.id ? e.to : e.from;
        const other = graph.nodes.find((n) => n.id === otherId);
        return { edge: e, other: other ?? { id: otherId, label: otherId, group: 'system' as const } };
      });
  }, [node, graph]);

  return (
    <div className="memory-node-panel open">
      <button className="memory-node-panel-close" onClick={onClose}>×</button>
      <div className="memory-node-panel-content">
        <div className="memory-node-panel-header">
          <span
            className="memory-node-panel-type"
            style={{ backgroundColor: `${GROUP_COLORS[node.group]}22`, color: GROUP_COLORS[node.group] }}
          >
            {GROUP_LABELS[node.group] ?? node.group}
          </span>
          <h2 className="memory-node-panel-title">{node.label}</h2>
          {node.title && node.title !== node.label && (
            <p className="memory-node-panel-subtitle">{node.title}</p>
          )}
        </div>

        {node.details && (
          <div className="memory-node-panel-section">
            <div className="memory-node-panel-section-title">内容</div>
            <div className="memory-node-panel-description">{node.details}</div>
          </div>
        )}

        <div className="memory-node-panel-section">
          <div className="memory-node-panel-section-title">元数据</div>
          <div className="memory-node-panel-meta">
            {node.projectId && (
              <div className="memory-node-panel-meta-row">
                <span className="memory-node-panel-meta-label">项目</span>
                <span>{node.projectId}</span>
              </div>
            )}
            {node.ownerId && (
              <div className="memory-node-panel-meta-row">
                <span className="memory-node-panel-meta-label">Owner</span>
                <span>{node.ownerId}</span>
              </div>
            )}
            {node.timestamp && (
              <div className="memory-node-panel-meta-row">
                <span className="memory-node-panel-meta-label">时间</span>
                <span>{node.timestamp}</span>
              </div>
            )}
            <div className="memory-node-panel-meta-row">
              <span className="memory-node-panel-meta-label">ID</span>
              <span>{node.id}</span>
            </div>
          </div>
        </div>

        {connections.length > 0 && (
          <div className="memory-node-panel-section">
            <div className="memory-node-panel-section-title">关联 ({connections.length})</div>
            <div className="memory-node-panel-connections">
              {connections.map(({ edge, other }) => (
                <button
                  key={edge.id}
                  className="memory-node-panel-connection"
                  onClick={() => onNodeClick?.(other)}
                >
                  <span
                    className="memory-node-panel-connection-dot"
                    style={{ backgroundColor: GROUP_COLORS[other.group] ?? '#8b949e' }}
                  />
                  <span className="memory-node-panel-connection-name">{other.label}</span>
                  {edge.label && <span className="memory-node-panel-connection-label">{edge.label}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
