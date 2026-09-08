import { useState } from 'react';
import { useIpc } from '../hooks/useIpc.js';
import { invoke } from '../api/electron-api.js';

interface KnowledgeItemDto {
  id: string;
  title: string;
  category: string;
  scope: string;
  confidence: string;
  source: string;
  tags: string[];
  updated: string;
  root: 'shared' | 'local';
  bodyPreview: string;
}

interface KnowledgeListResult {
  items: KnowledgeItemDto[];
  inbox: KnowledgeItemDto[];
}

const SOURCE_LABELS: Record<string, string> = {
  human: '人工',
  distilled: '蒸馏',
  archiver: '归档',
};

/**
 * 项目智库面板：策展正本（共享+本地）与蒸馏草稿箱（人审闸门）。
 */
export function KnowledgePanel({ projectId }: { projectId: string }) {
  const { data, refresh } = useIpc<KnowledgeListResult>('knowledge.list', { projectId });
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (method: 'knowledge.approve' | 'knowledge.dismiss', knowledgeId: string) => {
    setBusy(knowledgeId);
    try {
      await invoke(method, { projectId, knowledgeId });
      refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!data) return <div className="pipeline-loading">加载智库…</div>;

  return (
    <div className="knowledge-panel">
      {data.inbox.length > 0 && (
        <section className="knowledge-section">
          <h3>待审草稿（{data.inbox.length}）</h3>
          <p className="knowledge-hint">蒸馏管线产出的候选，批准后进入共享正本（随项目入库）。</p>
          {data.inbox.map(item => (
            <div key={item.id} className="knowledge-card inbox">
              <div className="knowledge-card-head">
                <strong>{item.title}</strong>
                <span className="knowledge-meta">
                  {item.category} · {SOURCE_LABELS[item.source] ?? item.source} · 置信{' '}
                  {item.confidence}
                </span>
              </div>
              <p className="knowledge-body">{item.bodyPreview}</p>
              <div className="knowledge-actions">
                <button
                  disabled={busy === item.id}
                  onClick={() => act('knowledge.approve', item.id)}
                >
                  批准入库
                </button>
                <button
                  className="pipeline-discard-btn"
                  disabled={busy === item.id}
                  onClick={() => act('knowledge.dismiss', item.id)}
                >
                  驳回
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="knowledge-section">
        <h3>策展正本（{data.items.length}）</h3>
        {data.items.length === 0 && (
          <p className="knowledge-hint">
            尚无策展知识。正本位于项目的 .codekeeper/knowledge/（Markdown + frontmatter）。
          </p>
        )}
        {data.items.map(item => (
          <div key={`${item.root}:${item.id}`} className="knowledge-card">
            <div className="knowledge-card-head">
              <strong>{item.title}</strong>
              <span className="knowledge-meta">
                {item.category} · {SOURCE_LABELS[item.source] ?? item.source} ·{' '}
                {item.root === 'shared' ? '共享' : '私有'} · {item.updated}
              </span>
            </div>
            {item.tags.length > 0 && (
              <div className="knowledge-tags">
                {item.tags.map(tag => (
                  <span key={tag} className="knowledge-tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <p className="knowledge-body">{item.bodyPreview}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
