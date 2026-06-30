import type { MemoryGraphNode } from '../../shared/types.js';

interface MemoryNodePanelProps {
  node: MemoryGraphNode;
  onClose: () => void;
}

/**
 * 节点详情侧面板
 */
export function MemoryNodePanel({ node, onClose }: MemoryNodePanelProps) {
  return (
    <div className="memory-node-panel">
      <button className="panel-close" onClick={onClose}>×</button>
      <div className="panel-content">
        <span className={`badge badge-${node.group}`}>{node.group}</span>
        <h3>{node.label}</h3>
        {node.title && <p className="panel-title">{node.title}</p>}
        {node.details && <p>{node.details}</p>}
        {node.timestamp && <p className="meta">时间: {node.timestamp}</p>}
        {node.projectId && <p className="meta">项目: {node.projectId}</p>}
        {node.ownerId && <p className="meta">Owner: {node.ownerId}</p>}
      </div>
    </div>
  );
}
