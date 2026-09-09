import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader.js';
import { MemoryGraphIcon, MemoryStatsIcon } from '../components/icons.js';
import { MemoryGraphView } from '../components/MemoryGraphView.js';
import { MemoryProgressView } from '../components/MemoryProgressView.js';
import { useMemoryGraph } from '../hooks/useMemoryGraph.js';
import { invoke } from '../api/electron-api.js';

interface ProjectKnowledgeSummary {
  project: { id: string; name: string };
  items: Array<{
    id: string;
    title: string;
    category: string;
    confidence: string;
    source: string;
    root: 'shared' | 'local';
    bodyPreview: string;
  }>;
  inboxCount: number;
  error?: string;
}

type KnowledgeView = 'curated' | 'memory' | 'stats';

/** 全局智库入口：把策展知识与 EverOS 经验记忆放在同一信息架构下。 */
export function KnowledgeHubPage() {
  const [view, setView] = useState<KnowledgeView>('curated');
  const { graph, loading, error, refresh } = useMemoryGraph();
  const [knowledge, setKnowledge] = useState<ProjectKnowledgeSummary[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setKnowledgeLoading(true);
    invoke<Array<{ id: string; name: string }>>('project.list')
      .then(async projects => {
        const summaries = await Promise.all(
          projects.map(async project => {
            try {
              const result = await invoke<{
                items: ProjectKnowledgeSummary['items'];
                inbox: unknown[];
              }>('knowledge.list', { projectId: project.id });
              return { project, items: result.items, inboxCount: result.inbox.length };
            } catch (reason) {
              return {
                project,
                items: [],
                inboxCount: 0,
                error: reason instanceof Error ? reason.message : String(reason),
              };
            }
          })
        );
        if (!cancelled) setKnowledge(summaries);
      })
      .catch(reason => {
        if (!cancelled)
          setKnowledgeError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setKnowledgeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
            <p>项目级策展知识在项目详情的「知识」页维护，这里按项目集中浏览。</p>
          </div>
          {knowledgeLoading && <div className="knowledge-hub-empty">加载策展知识...</div>}
          {knowledgeError && (
            <div className="error-message">加载策展知识失败：{knowledgeError}</div>
          )}
          {!knowledgeLoading && !knowledgeError && knowledge.length === 0 && (
            <div className="knowledge-hub-empty">暂无项目，请先从仪表盘注册项目。</div>
          )}
          {!knowledgeLoading &&
            !knowledgeError &&
            knowledge.map(summary => (
              <div key={summary.project.id} className="knowledge-project-group">
                <div className="knowledge-project-heading">
                  <Link to={`/project/${summary.project.id}`}>{summary.project.name}</Link>
                  <span>
                    {summary.items.length} 条正本 · {summary.inboxCount} 条待审草稿
                  </span>
                </div>
                {summary.error ? (
                  <div className="error-message">该项目知识加载失败：{summary.error}</div>
                ) : summary.items.length === 0 ? (
                  <div className="knowledge-hub-empty">该项目暂无策展知识。</div>
                ) : (
                  <div className="knowledge-project-items">
                    {summary.items.slice(0, 6).map(item => (
                      <div
                        key={`${summary.project.id}:${item.root}:${item.id}`}
                        className="knowledge-card"
                      >
                        <div className="knowledge-card-head">
                          <strong>{item.title}</strong>
                          <span className="knowledge-meta">
                            {item.category} · {item.confidence} ·{' '}
                            {item.root === 'shared' ? '共享' : '私有'} · {item.source}
                          </span>
                        </div>
                        <p className="knowledge-body">{item.bodyPreview}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
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
          {!loading && !error && graph.stats.projectCount === 0 && (
            <div className="memory-graph-empty">暂无项目，请先从仪表盘注册项目。</div>
          )}
          {!loading && !error && graph.stats.projectCount > 0 && (
            <MemoryProgressView stats={graph.stats} graph={graph} />
          )}
        </section>
      )}
    </div>
  );
}
