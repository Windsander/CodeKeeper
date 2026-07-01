import { useMemoryGraph } from '../hooks/useMemoryGraph';
import { MemoryProgressView } from '../components/MemoryProgressView';

/**
 * 记忆统计页面：展示 Progress View
 */
export function MemoryStatsPage() {
  const { graph, loading, error, refresh } = useMemoryGraph();
  const stats = graph.stats;

  return (
    <div className="memory-graph-page">
      <header className="memory-graph-header">
        <div className="memory-graph-header-left">
          <div className="memory-graph-logo">📊</div>
          <h1 className="memory-graph-title">记忆统计</h1>
        </div>

        <div className="memory-graph-header-right">
          <div className="memory-graph-header-stats">
            项目 {stats.projectCount} · 总记忆 {stats.totalMemories} · 关联 {stats.totalEdges} · 活跃 {stats.activeDays} 天
          </div>
          <button className="memory-graph-refresh" onClick={() => refresh()} title="刷新">
            ↻
          </button>
        </div>
      </header>

      {error && <div className="memory-graph-alert">加载失败: {error}</div>}
      {loading && <div className="memory-graph-loading">Loading…</div>}

      <div className="memory-graph-viewport progress-active">
        {!loading && !error && stats.projectCount === 0 && (
          <div className="memory-graph-empty">
            暂无项目，请先注册项目后再查看记忆统计。
          </div>
        )}
        {!loading && !error && stats.projectCount > 0 && (
          <MemoryProgressView stats={graph.stats} graph={graph} />
        )}
      </div>
    </div>
  );
}
