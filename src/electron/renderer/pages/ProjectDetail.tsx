import { useState } from 'react';
import { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useIpc } from '../hooks/useIpc';
import { ContextView } from '../components/ContextView';
import { SuggestionList } from '../components/SuggestionList';
import { invoke } from '../api/electron-api';
import type { ProjectStatus } from '../../shared/types';

import { ArchiveTree } from '../components/ArchiveTree';

type Tab = 'context' | 'activity' | 'archive' | 'status';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('context');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const { data: project } = useIpc<{ name: string; rootPath: string; archiveRoot?: string }>('project.get', { projectId: id });
  const { data: context, refresh: refreshContext } = useIpc<{ content: string }>('project.context', { projectId: id });
  const { data: suggestions, refresh: refreshSuggestions } = useIpc<{ content: string }>('project.suggestions', { projectId: id });
  const { data: archiveTree, refresh: refreshArchiveTree } = useIpc<{ tree: { name: string; path: string; relPath: string; type: 'file' | 'directory'; children?: unknown[] } | null }>('project.archive.tree', { projectId: id });
  const { data: status, refresh: refreshStatus } = useIpc<ProjectStatus>('project.status', { projectId: id });

  useEffect(() => {
    const unsubscribe = window.electronAPI.onPush((event) => {
      if (event.event === 'archive-tree-changed' && (event.payload as { projectId?: string }).projectId === id) {
        refreshArchiveTree();
      }
    });
    return unsubscribe;
  }, [id, refreshArchiveTree]);

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      await invoke('project.scan', { projectId: id });
      await Promise.all([refreshContext(), refreshSuggestions(), refreshArchiveTree(), refreshStatus()]);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div>
      <Link to="/" className="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        返回仪表盘
      </Link>
      <div className="page-header">
        <h1 className="page-title">{project?.name ?? '项目详情'}</h1>
        <button className="btn btn-primary" onClick={scan} disabled={scanning}>
          {scanning ? '扫描中...' : '立即扫描'}
        </button>
      </div>
      {project && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="project-meta">项目路径: {project.rootPath}</div>
          {project.archiveRoot && <div className="project-meta">归档位置: {project.archiveRoot}</div>}
        </div>
      )}
      {scanError && <div className="error-message" style={{ marginBottom: 16 }}>扫描失败: {scanError}</div>}
      <div className="tabs">
        <button
          className={`tab-btn${tab === 'context' ? ' active' : ''}`}
          onClick={() => setTab('context')}
        >
          Context
        </button>
        <button
          className={`tab-btn${tab === 'activity' ? ' active' : ''}`}
          onClick={() => setTab('activity')}
        >
          Activity Log
        </button>
        <button
          className={`tab-btn${tab === 'archive' ? ' active' : ''}`}
          onClick={() => setTab('archive')}
        >
          Archive
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
        {tab === 'activity' && suggestions && <SuggestionList content={suggestions.content} />}
        {tab === 'archive' && <ArchiveTree tree={archiveTree?.tree ?? null} />}
        {tab === 'status' && status && (
          <pre className="log-viewer">{JSON.stringify(status, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
