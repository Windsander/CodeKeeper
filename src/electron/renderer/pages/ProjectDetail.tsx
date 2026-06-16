import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useIpc } from '../hooks/useIpc';
import { ContextView } from '../components/ContextView';
import { SuggestionList } from '../components/SuggestionList';
import type { ProjectStatus } from '../../shared/types';

type Tab = 'context' | 'suggestions' | 'status';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('context');
  const { data: context } = useIpc<{ content: string }>('project.context', { projectId: id });
  const { data: suggestions } = useIpc<{ content: string }>('project.suggestions', { projectId: id });
  const { data: status } = useIpc<ProjectStatus>('project.status', { projectId: id });

  return (
    <div>
      <Link to="/" className="back-link">← 返回</Link>
      <h1 className="page-title">项目详情</h1>
      <div className="tabs">
        <button
          className={`tab-btn${tab === 'context' ? ' active' : ''}`}
          onClick={() => setTab('context')}
        >
          Context
        </button>
        <button
          className={`tab-btn${tab === 'suggestions' ? ' active' : ''}`}
          onClick={() => setTab('suggestions')}
        >
          Suggestions
        </button>
        <button
          className={`tab-btn${tab === 'status' ? ' active' : ''}`}
          onClick={() => setTab('status')}
        >
          Status
        </button>
      </div>
      <div className="card">
        {tab === 'context' && context && <ContextView content={context.content} />}
        {tab === 'suggestions' && suggestions && <SuggestionList content={suggestions.content} />}
        {tab === 'status' && status && (
          <pre className="log-viewer">{JSON.stringify(status, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
