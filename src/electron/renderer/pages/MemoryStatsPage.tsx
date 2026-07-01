import { useMemoryGraph } from '../hooks/useMemoryGraph';
import { PageLayout } from '../components/PageLayout';
import { MemoryStatsIcon } from '../components/icons';
import { MemoryProgressView } from '../components/MemoryProgressView';

/**
 * 记忆统计页面：使用标准 PageLayout + 卡片布局展示 Progress View
 */
export function MemoryStatsPage() {
  const { graph, loading, error, refresh } = useMemoryGraph();
  const stats = graph.stats;

  return (
    <PageLayout
      icon={<MemoryStatsIcon />}
      title="记忆统计"
      onRefresh={() => refresh()}
    >
      <div className="memory-stats-page">
        {error && <div className="error-message">加载失败: {error}</div>}
        {loading && <div className="loading">Loading…</div>}

        {!loading && !error && stats.projectCount === 0 && (
          <div className="empty-state">
            <h3>暂无项目</h3>
            <p>请先注册项目后再查看记忆统计。</p>
          </div>
        )}
        {!loading && !error && stats.projectCount > 0 && (
          <MemoryProgressView stats={graph.stats} graph={graph} />
        )}
      </div>
    </PageLayout>
  );
}
