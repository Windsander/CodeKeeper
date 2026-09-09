import { useState } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { MemoryGraphIcon, MemoryStatsIcon } from '../components/icons.js';
import { MemoryGraphView } from '../components/MemoryGraphView.js';
import { MemoryProgressView } from '../components/MemoryProgressView.js';
import { useMemoryGraph } from '../hooks/useMemoryGraph.js';

type KnowledgeView = 'curated' | 'memory' | 'stats';

/** 全局智库入口：把策展知识与 EverOS 经验记忆放在同一信息架构下。 */
export function KnowledgeHubPage() {
  const [view, setView] = useState<KnowledgeView>('curated');
  const { graph, loading, error, refresh } = useMemoryGraph();

  return (
    <div className="knowledge-hub-page">
      <PageHeader icon={<MemoryGraphIcon />} title="智库" />
      <div className="tabs knowledge-hub-tabs">
        <button
          type="button"
          className={`tab-btn${view === 'curated' ? ' active' : ''}`}
          onClick={() => setView('curated')}
        >
          策展知识
        </button>
        <button
          type="button"
          className={`tab-btn${view === 'memory' ? ' active' : ''}`}
          onClick={() => setView('memory')}
        >
          <MemoryGraphIcon /> 记忆图谱
        </button>
        <button
          type="button"
          className={`tab-btn${view === 'stats' ? ' active' : ''}`}
          onClick={() => setView('stats')}
        >
          <MemoryStatsIcon /> 记忆统计
        </button>
      </div>

      {view === 'curated' && (
        <section className="knowledge-hub-curated">
          <div className="knowledge-hub-intro">
            <h2>策展知识</h2>
            <p>项目级策展知识在项目详情的「知识」页维护。这里统一查看记忆索引与项目入口。</p>
          </div>
          <div className="knowledge-hub-empty">
            <strong>从项目进入知识库</strong>
            <span>打开任意项目，在「知识」页查看共享正本、私有正本和待审蒸馏草稿。</span>
          </div>
        </section>
      )}
      {view === 'memory' && (
        <section className="knowledge-hub-memory">
          <button type="button" className="knowledge-refresh" onClick={() => refresh()}>
            刷新记忆
          </button>
          {error && <div className="memory-graph-alert">加载失败: {error}</div>}
          {loading && <div className="loading">加载记忆...</div>}
          {!loading && !error && graph.stats.projectCount === 0 && (
            <div className="memory-graph-empty">暂无项目，请先注册项目。</div>
          )}
          {!loading && !error && graph.stats.projectCount > 0 && <MemoryGraphView graph={graph} />}
        </section>
      )}
      {view === 'stats' && (
        <section className="knowledge-hub-memory">
          <button type="button" className="knowledge-refresh" onClick={() => refresh()}>
            刷新统计
          </button>
          {error && <div className="error-message">加载失败: {error}</div>}
          {loading && <div className="loading">加载统计...</div>}
          {!loading && !error && graph.stats.projectCount > 0 && (
            <MemoryProgressView stats={graph.stats} graph={graph} />
          )}
        </section>
      )}
    </div>
  );
}
