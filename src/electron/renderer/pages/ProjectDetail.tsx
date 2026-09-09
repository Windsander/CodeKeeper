import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useIpc } from '../hooks/useIpc';
import { PageLayout } from '../components/PageLayout';
import { ProjectIcon } from '../components/icons';
import { ContextView } from '../components/ContextView';
import { invoke } from '../api/electron-api';

import { ArchiveTree } from '../components/ArchiveTree';
import { KnowledgePanel } from '../components/KnowledgePanel';
import { PipelineCanvas } from '../components/PipelineCanvas';
import { RunCenter } from '../components/RunCenter.js';
import { ProjectSettingsPanel } from '../components/ProjectSettingsPanel.js';
import type { FileTreeNode } from '../components/ArchiveTree';

type Tab = 'pipeline' | 'run' | 'knowledge' | 'archive' | 'settings';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('pipeline');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const { data: project } = useIpc<{ name: string; rootPath: string; archiveRoot?: string }>(
    'project.get',
    { projectId: id }
  );
  const { data: context, refresh: refreshContext } = useIpc<{ content: string }>(
    'project.context',
    { projectId: id }
  );
  const { data: archiveTree, refresh: refreshArchiveTree } = useIpc<{ tree: FileTreeNode | null }>(
    'project.archive.tree',
    { projectId: id }
  );

  useEffect(() => {
    const unsubscribe = window.electronAPI.onPush(event => {
      if (
        event.event === 'archive-tree-changed' &&
        (event.payload as { projectId?: string }).projectId === id
      ) {
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
      await Promise.all([refreshContext(), refreshArchiveTree()]);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const refreshAll = () => {
    refreshContext();
    refreshArchiveTree();
  };

  return (
    <PageLayout icon={<ProjectIcon />} title={project?.name ?? '项目详情'} onRefresh={refreshAll}>
      <Link to="/" className="back-link">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        返回仪表盘
      </Link>

      {project && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 16,
            }}
          >
            <div>
              <div className="project-meta">项目路径: {project.rootPath}</div>
              {project.archiveRoot && (
                <div className="project-meta">归档位置: {project.archiveRoot}</div>
              )}
            </div>
            <button className="btn btn-primary" onClick={scan} disabled={scanning}>
              {scanning ? '扫描中...' : '立即扫描'}
            </button>
          </div>
        </div>
      )}

      {scanError && (
        <div className="error-message" style={{ marginBottom: 16 }}>
          扫描失败: {scanError}
        </div>
      )}

      <div className="tabs">
        <button
          className={`tab-btn${tab === 'pipeline' ? ' active' : ''}`}
          onClick={() => setTab('pipeline')}
        >
          管线
        </button>
        <button
          className={`tab-btn${tab === 'run' ? ' active' : ''}`}
          onClick={() => setTab('run')}
        >
          运行
        </button>
        <button
          className={`tab-btn${tab === 'knowledge' ? ' active' : ''}`}
          onClick={() => setTab('knowledge')}
        >
          知识
        </button>
        <button
          className={`tab-btn${tab === 'archive' ? ' active' : ''}`}
          onClick={() => setTab('archive')}
        >
          归档
        </button>
        <button
          className={`tab-btn${tab === 'settings' ? ' active' : ''}`}
          onClick={() => setTab('settings')}
        >
          设置
        </button>
      </div>

      <div className="card">
        {tab === 'pipeline' && id && <PipelineCanvas key={id} projectId={id} />}
        {tab === 'run' && id && <RunCenter projectId={id} />}
        {tab === 'knowledge' && id && <KnowledgePanel key={id} projectId={id} />}
        {tab === 'archive' && (
          <div className="archive-tab-content">
            <div className="project-section-heading">
              <h2>归档内容</h2>
              <span>文件优先的项目知识副本</span>
            </div>
            <ArchiveTree tree={archiveTree?.tree ?? null} />
            {context?.content ? (
              <section className="archive-context-section">
                <div className="project-section-heading">
                  <h2>项目上下文</h2>
                  <span>供角色召回的归档摘要</span>
                </div>
                <ContextView content={context.content} />
              </section>
            ) : (
              <div className="run-empty">尚未生成项目上下文。</div>
            )}
          </div>
        )}
        {tab === 'settings' && id && <ProjectSettingsPanel projectId={id} />}
      </div>
    </PageLayout>
  );
}
