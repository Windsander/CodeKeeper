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

  const stats = graph.stats;

  return (
    <div className="memory-graph-page">
      <header className="memory-graph-header">
        <div className="memory-graph-header-left">
          <div className="memory-graph-logo">🧠</div>
          <h1 className="memory-graph-title">记忆图谱</h1>
        </div>

        <div className="memory-graph-view-toggle">
          <button
            className={`memory-graph-view-btn${tab === 'graph' ? ' active' : ''}`}
            onClick={() => setTab('graph')}
          >
            Graph View
          </button>
          <button
            className={`memory-graph-view-btn${tab === 'progress' ? ' active' : ''}`}
            onClick={() => setTab('progress')}
          >
            Progress View
          </button>
        </div>

        <div className="memory-graph-header-right">
          <div className="memory-graph-header-stats">
            总记忆 {stats.totalMemories} · 关联 {stats.totalEdges} · 活跃 {stats.activeDays} 天
          </div>
          <button className="memory-graph-refresh" onClick={() => refresh()} title="刷新">
            ↻
          </button>
        </div>
      </header>

      {error && <div className="memory-graph-alert">加载失败: {error}</div>}
      {loading && <div className="memory-graph-loading">Loading…</div>}

      <div className={`memory-graph-viewport${tab === 'graph' ? '' : ' progress-active'}`}>
        {!loading && !error && stats.totalMemories === 0 && (
          <div className="memory-graph-empty">
            暂无记忆数据，运行一次 reviewer / maintainer / archiver 后会自动聚合到这里。
          </div>
        )}
        {!loading && tab === 'graph' && stats.totalMemories > 0 && <MemoryGraphView graph={graph} />}
        {!loading && tab === 'progress' && <MemoryProgressView stats={graph.stats} graph={graph} />}
      </div>
    </div>
  );
}
