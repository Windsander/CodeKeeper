import type { MemoryGraphStats } from '../../shared/types.js';

interface MemoryProgressViewProps {
  stats: MemoryGraphStats;
}

/**
 * Progress View 页签：统计卡片与增长图表
 */
export function MemoryProgressView({ stats }: MemoryProgressViewProps) {
  const maxGrowth = Math.max(1, ...stats.dailyGrowth.map((d) => d.count));
  return (
    <div className="memory-progress-view">
      <div className="stats-grid">
        <div className="stat-card"><div className="label">总记忆数</div><div className="value">{stats.totalMemories}</div></div>
        <div className="stat-card"><div className="label">总关联数</div><div className="value">{stats.totalEdges}</div></div>
        <div className="stat-card"><div className="label">活跃天数</div><div className="value">{stats.activeDays}</div></div>
        <div className="stat-card"><div className="label">项目数</div><div className="value">{stats.projectCount}</div></div>
      </div>

      <div className="growth-section">
        <div className="section-title">记忆增长（最近 14 天）</div>
        <div className="growth-chart">
          {stats.dailyGrowth.map((d) => (
            <div key={d.date} className="chart-bar-container">
              <div className="chart-bar-wrapper">
                <div className="chart-bar" style={{ height: `${(d.count / maxGrowth) * 100}%` }} />
              </div>
              <div className="chart-label">{d.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
