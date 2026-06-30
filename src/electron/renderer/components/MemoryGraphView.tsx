import { useState, useCallback } from 'react';
import { MemoryGraph } from './MemoryGraph';
import { MemoryNodePanel } from './MemoryNodePanel';
import type { MemoryGraphNode, MemoryGraph as MemoryGraphType } from '../../shared/types.js';

interface MemoryGraphViewProps {
  graph: MemoryGraphType;
}

/**
 * Graph View 页签：画布 + 节点详情面板
 */
export function MemoryGraphView({ graph }: MemoryGraphViewProps) {
  const [selectedNode, setSelectedNode] = useState<MemoryGraphNode | null>(null);

  const handleNodeClick = useCallback((node: MemoryGraphNode) => {
    setSelectedNode(node);
  }, []);

  return (
    <div className="memory-graph-view">
      <MemoryGraph graph={graph} onNodeSelect={handleNodeClick} />
      {selectedNode && (
        <MemoryNodePanel
          node={selectedNode}
          graph={graph}
          onClose={() => setSelectedNode(null)}
          onNodeClick={handleNodeClick}
        />
      )}
    </div>
  );
}
