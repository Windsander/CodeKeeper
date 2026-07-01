import { useMemoryGraph } from '../hooks/useMemoryGraph';
import { PageHeader } from '../components/PageHeader';
import { MemoryGraphIcon } from '../components/icons';
import { MemoryGraphView } from '../components/MemoryGraphView';

/**
 * 记忆图谱页面：仅展示 Graph View
 */
export function MemoryGraphPage() {
  const { graph, loading, error, refresh } = useMemoryGraph();
  const stats = graph.stats;

  return (
    <div className="memory-graph-page">
      <PageHeader
        icon={<MemoryGraphIcon />}
        title="记忆图谱"
        onRefresh={() => refresh()}
      />

      {error && <div className="memory-graph-alert">加载失败: {error}</div>}
      {loading && <div className="memory-graph-loading">Loading…</div>}

      <div className="memory-graph-viewport">
        {!loading && !error && stats.projectCount === 0 && (
          <div className="memory-graph-empty">
            暂无项目，请先注册项目后再查看记忆图谱。
          </div>
        )}
        {!loading && !error && stats.projectCount > 0 && <MemoryGraphView graph={graph} />}
        {!loading && !error && stats.projectCount > 0 && stats.totalMemories === 0 && (
          <div className="memory-graph-empty-hint">
            暂无记忆数据，运行一次 reviewer / maintainer / archiver 后会自动聚合到这里。
          </div>
        )}
      </div>
    </div>
  );
}
