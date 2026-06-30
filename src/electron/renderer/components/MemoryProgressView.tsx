import { useMemo } from 'react';
import type { MemoryGraph, MemoryGraphStats } from '../../shared/types.js';

interface MemoryProgressViewProps {
  stats: MemoryGraphStats;
  graph: MemoryGraph;
}

/**
 * Progress View 页签：统计、增长图、时间线（EverOS 风格）
 */
export function MemoryProgressView({ stats, graph }: MemoryProgressViewProps) {
  const maxGrowth = Math.max(1, ...stats.dailyGrowth.map((d) => d.count));

  const timeline = useMemo(() => {
    const groups = new Map<string, typeof graph.nodes>();
    for (const node of graph.nodes) {
      if (!node.timestamp) continue;
      const date = node.timestamp.slice(0, 10);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(node);
    }
    return [...groups.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 14)
      .map(([date, nodes]) => ({
        date,
        count: nodes.length,
        nodes: nodes.slice(0, 5),
      }));
  }, [graph]);

  return (
    <div className="memory-progress-view">
      <div className="memory-progress-container">
        <div className="memory-progress-stats">
          <div className="memory-progress-stat-card">
            <div className="memory-progress-stat-label">Total Memories</div>
            <div className="memory-progress-stat-value">{stats.totalMemories}</div>
            <div className="memory-progress-stat-trend">+{stats.dailyGrowth.slice(-1)[0]?.count ?? 0} today</div>
          </div>
          <div className="memory-progress-stat-card">
            <div className="memory-progress-stat-label">Connections</div>
            <div className="memory-progress-stat-value">{stats.totalEdges}</div>
            <div className="memory-progress-stat-trend">across {stats.projectCount} projects</div>
          </div>
          <div className="memory-progress-stat-card">
            <div className="memory-progress-stat-label">Active Days</div>
            <div className="memory-progress-stat-value">{stats.activeDays}</div>
            <div className="memory-progress-stat-trend neutral">keep building</div>
          </div>
          <div className="memory-progress-stat-card">
            <div className="memory-progress-stat-label">Nodes</div>
            <div className="memory-progress-stat-value">{stats.totalNodes}</div>
            <div className="memory-progress-stat-trend">+{stats.totalMemories} memories</div>
          </div>
        </div>

        <div className="memory-progress-card">
          <div className="memory-progress-card-title">Memory Growth (Last 14 Days)</div>
          <div className="memory-progress-growth">
            {stats.dailyGrowth.map((d) => (
              <div key={d.date} className="memory-progress-bar-wrap">
                <div className="memory-progress-bar-track">
                  <div
                    className="memory-progress-bar"
                    style={{ height: `${(d.count / maxGrowth) * 100}%` }}
                  >
                    <div className="memory-progress-bar-tip">{d.count}</div>
                  </div>
                </div>
                <div className="memory-progress-bar-label">{d.date.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="memory-progress-card">
          <div className="memory-progress-card-title">Daily Memory Timeline</div>
          <div className="memory-progress-timeline">
            {timeline.map((day, idx) => (
              <div key={day.date} className="memory-progress-day">
                <div className={`memory-progress-dot${idx === 0 ? ' today' : ''}`} />
                <div className="memory-progress-day-header">
                  <span className="memory-progress-day-date">{day.date}</span>
                  <span className="memory-progress-day-badge">{day.count} memories</span>
                </div>
                <div className="memory-progress-day-items">
                  {day.nodes.map((node) => (
                    <div key={node.id} className="memory-progress-item">
                      <div className="memory-progress-item-title">{node.label}</div>
                      {node.details && <div className="memory-progress-item-desc">{node.details.slice(0, 120)}</div>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
