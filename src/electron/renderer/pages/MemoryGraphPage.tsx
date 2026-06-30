import { useState } from 'react';
import { useMemoryGraph } from '../hooks/useMemoryGraph';
import { MemoryGraphView } from '../components/MemoryGraphView';
import { MemoryProgressView } from '../components/MemoryProgressView';

type Tab = 'graph' | 'progress';

/**
 * 记忆图谱页面：Graph View + Progress View 双页签
 */
export function MemoryGraphPage() {
  const [tab, setTab] = useState<Tab>('graph');
  const { graph, loading, error, refresh } = useMemoryGraph();

  return (
    <div className="memory-graph-page">
      <div className="page-header">
        <h1 className="page-title">记忆图谱</h1>
        <div className="view-toggle">
          <button className={`view-btn${tab === 'graph' ? ' active' : ''}`} onClick={() => setTab('graph')}>Graph View</button>
          <button className={`view-btn${tab === 'progress' ? ' active' : ''}`} onClick={() => setTab('progress')}>Progress View</button>
        </div>
        <button className="btn btn-primary" onClick={() => refresh()}>刷新</button>
      </div>

      {error && <div className="alert alert-danger">加载失败: {error}</div>}
      {loading && <div className="loading">加载中…</div>}

      {!loading && tab === 'graph' && <MemoryGraphView graph={graph} />}
      {!loading && tab === 'progress' && <MemoryProgressView stats={graph.stats} />}
    </div>
  );
}
