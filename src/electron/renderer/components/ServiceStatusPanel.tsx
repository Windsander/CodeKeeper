import { useState, useEffect, useRef } from 'react';
import type { DaemonStatus, LocalModelStatus, ModelServiceStatus, RemoteModelStatus } from '../../shared/service-status';
import { CircularProgress } from './CircularProgress';
import { useModelLogs } from '../hooks/useModelLogs';

export interface ServiceStatusPanelProps {
  daemon: DaemonStatus | null;
  localModel: LocalModelStatus | null;
  remoteModel: RemoteModelStatus | null;
}

type NodeKey = 'daemon' | 'everos' | 'localModel' | 'embedding' | 'rerank' | 'remoteModel' | 'remoteModel-llm' | 'remoteModel-multimodal';

interface StatusDisplay {
  label: string;
  badgeClass: string;
  dotClass: string;
}

const STATE_DISPLAY: Record<ModelServiceStatus['state'], StatusDisplay> = {
  idle: { label: '闲置', badgeClass: 'badge-secondary', dotClass: 'status-dot-idle' },
  starting: { label: '启动中', badgeClass: 'badge-info', dotClass: 'status-dot-starting' },
  downloading: { label: '下载中', badgeClass: 'badge-warning', dotClass: 'status-dot-downloading' },
  loading: { label: '加载中', badgeClass: 'badge-info', dotClass: 'status-dot-loading' },
  running: { label: '运行中', badgeClass: 'badge-success', dotClass: 'status-dot-running' },
  error: { label: '错误', badgeClass: 'badge-danger', dotClass: 'status-dot-error' },
};

const MAX_ERROR_LENGTH = 200;

function truncateError(message: string | null | undefined): { text: string; truncated: boolean } {
  if (!message) return { text: '', truncated: false };
  if (message.length <= MAX_ERROR_LENGTH) return { text: message, truncated: false };
  return { text: `${message.slice(0, MAX_ERROR_LENGTH)}...`, truncated: true };
}

function StatusBadge({ state, isDaemon = false, running }: { state?: string; isDaemon?: boolean; running?: boolean }) {
  let display: StatusDisplay;
  if (isDaemon) {
    display = running
      ? { label: '运行中', badgeClass: 'badge-success', dotClass: 'status-dot-running' }
      : { label: '未运行', badgeClass: 'badge-secondary', dotClass: 'status-dot-idle' };
  } else if (state && state in STATE_DISPLAY) {
    display = STATE_DISPLAY[state as ModelServiceStatus['state']];
  } else {
    display = { label: state ?? '未知', badgeClass: 'badge-secondary', dotClass: 'status-dot-idle' };
  }
  return (
    <span className={`badge ${display.badgeClass} status-badge`}>
      <span className={`status-dot ${display.dotClass}`} />
      {display.label}
    </span>
  );
}

interface TreeNodeProps {
  title: string;
  nodeKey: NodeKey;
  icon: string;
  status?: string;
  progress?: number | null;
  isDaemon?: boolean;
  running?: boolean;
  url?: string | null;
  error?: string | null | undefined;
  expandedKeys: Set<NodeKey>;
  onToggle: (key: NodeKey) => void;
  children?: React.ReactNode;
}

function TreeNode({
  title,
  nodeKey,
  icon,
  status,
  progress,
  isDaemon,
  running,
  url,
  error,
  expandedKeys,
  onToggle,
  children,
}: TreeNodeProps) {
  const hasError = Boolean(error);
  const isExpanded = expandedKeys.has(nodeKey);
  const { text: errorText, truncated } = truncateError(error);

  return (
    <div className="service-status-node" data-testid={`status-node-${nodeKey}`}>
      <div
        className={`service-status-row ${hasError ? 'service-status-row--error' : ''}`}
        onClick={hasError ? () => onToggle(nodeKey) : undefined}
        role={hasError ? 'button' : undefined}
        tabIndex={hasError ? 0 : undefined}
      >
        <span className="service-status-icon">{icon}</span>
        <span className="service-status-title">{title}</span>
        {progress !== undefined && (
          <span className="service-status-progress">
            <CircularProgress value={progress} size={14} strokeWidth={2} />
          </span>
        )}
        <StatusBadge state={status} isDaemon={isDaemon} running={running} />
      </div>
      {url && status === 'running' && (
        <div className="service-status-url">{url}</div>
      )}
      {hasError && (
        <div className={`service-status-error ${isExpanded ? 'service-status-error--expanded' : ''}`}>
          <div className="service-status-error-inner">
            {errorText}
            {truncated && <span className="service-status-error-hint">（查看日志获取完整信息）</span>}
          </div>
        </div>
      )}
      {children && <div className="service-status-children">{children}</div>}
    </div>
  );
}

function ModelLogViewer() {
  const { embedding, rerank, loading, error } = useModelLogs();
  const embeddingRef = useRef<HTMLPreElement>(null);
  const rerankRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (embeddingRef.current) {
      embeddingRef.current.scrollTop = embeddingRef.current.scrollHeight;
    }
  }, [embedding]);

  useEffect(() => {
    if (rerankRef.current) {
      rerankRef.current.scrollTop = rerankRef.current.scrollHeight;
    }
  }, [rerank]);

  if (loading && embedding.length === 0 && rerank.length === 0) {
    return <div className="model-log-empty">加载日志中...</div>;
  }
  if (error) {
    return <div className="model-log-error">读取日志失败: {error}</div>;
  }

  return (
    <div className="model-log-viewer">
      <div className="model-log-section">
        <h4 className="model-log-title">Embedding</h4>
        <pre ref={embeddingRef} className="model-log-pre">
          {embedding.join('\n') || '暂无日志'}
        </pre>
      </div>
      <div className="model-log-section">
        <h4 className="model-log-title">Rerank</h4>
        <pre ref={rerankRef} className="model-log-pre">
          {rerank.join('\n') || '暂无日志'}
        </pre>
      </div>
    </div>
  );
}

export function ServiceStatusPanel({ daemon, localModel, remoteModel }: ServiceStatusPanelProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<NodeKey>>(new Set());
  const [activeTab, setActiveTab] = useState<'status' | 'logs'>('status');

  const toggle = (key: NodeKey) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="service-status-panel card">
      <div className="service-status-header">
        <h3 className="service-status-title">服务状态</h3>
        <div className="service-status-tabs">
          <button
            type="button"
            className={`tab-btn${activeTab === 'status' ? ' active' : ''}`}
            onClick={() => setActiveTab('status')}
          >
            状态
          </button>
          <button
            type="button"
            className={`tab-btn${activeTab === 'logs' ? ' active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            日志
          </button>
        </div>
      </div>
      <div className="service-status-body">
        {activeTab === 'status' ? (
          <div className="service-status-tree">
            <TreeNode
              title="Daemon"
              nodeKey="daemon"
              icon="🖥️"
              isDaemon
              running={daemon?.daemonRunning ?? false}
              error={daemon?.everos?.state === 'error' ? daemon.everos.error : null}
              expandedKeys={expandedKeys}
              onToggle={toggle}
            >
              <TreeNode
                title="记忆服务（EverOS）"
                nodeKey="everos"
                icon="🧠"
                status={daemon?.everos?.state}
                url={daemon?.everos?.url}
                error={daemon?.everos?.error ?? null}
                expandedKeys={expandedKeys}
                onToggle={toggle}
              />
              <TreeNode
                title="本地模型服务"
                nodeKey="localModel"
                icon="⚙️"
                status={inferLocalModelState(localModel)}
                error={inferLocalModelError(localModel) ?? null}
                expandedKeys={expandedKeys}
                onToggle={toggle}
              >
                <TreeNode
                  title="Embedding"
                  nodeKey="embedding"
                  icon="🔤"
                  status={localModel?.embedding.state}
                  progress={localModel?.embedding.progress}
                  url={localModel?.embedding.url}
                  error={localModel?.embedding.error ?? null}
                  expandedKeys={expandedKeys}
                  onToggle={toggle}
                />
                <TreeNode
                  title="Rerank"
                  nodeKey="rerank"
                  icon="🔍"
                  status={localModel?.rerank.state}
                  progress={localModel?.rerank.progress}
                  url={localModel?.rerank.url}
                  error={localModel?.rerank.error ?? null}
                  expandedKeys={expandedKeys}
                  onToggle={toggle}
                />
              </TreeNode>
              {remoteModel && (
                <TreeNode
                  title="远端模型服务"
                  nodeKey="remoteModel"
                  icon="🌐"
                  status={inferRemoteModelState(remoteModel)}
                  error={inferRemoteModelError(remoteModel) ?? null}
                  expandedKeys={expandedKeys}
                  onToggle={toggle}
                >
                  <TreeNode
                    title={remoteModel.llm.modelLabel}
                    nodeKey="remoteModel-llm"
                    icon="💬"
                    status={remoteModel.llm.state}
                    error={remoteModel.llm.error ?? null}
                    expandedKeys={expandedKeys}
                    onToggle={toggle}
                  />
                  <TreeNode
                    title={remoteModel.multimodal.modelLabel}
                    nodeKey="remoteModel-multimodal"
                    icon="🖼️"
                    status={remoteModel.multimodal.state}
                    error={remoteModel.multimodal.error ?? null}
                    expandedKeys={expandedKeys}
                    onToggle={toggle}
                  />
                </TreeNode>
              )}
            </TreeNode>
          </div>
        ) : (
          <ModelLogViewer />
        )}
      </div>
    </div>
  );
}

function inferLocalModelState(localModel: LocalModelStatus | null): ModelServiceStatus['state'] | undefined {
  if (!localModel) return 'idle';
  const states = [localModel.embedding.state, localModel.rerank.state];
  if (states.some((s) => s === 'error')) return 'error';
  if (states.some((s) => s === 'running')) return 'running';
  if (states.some((s) => s === 'loading')) return 'loading';
  if (states.some((s) => s === 'downloading')) return 'downloading';
  if (states.some((s) => s === 'starting')) return 'starting';
  return 'idle';
}

function inferLocalModelError(localModel: LocalModelStatus | null): string | null {
  if (!localModel) return null;
  const errors = [localModel.embedding.error, localModel.rerank.error].filter(Boolean);
  return errors.length > 0 ? errors.join('; ') : null;
}

function inferRemoteModelState(remoteModel: RemoteModelStatus | null): 'unconfigured' | 'running' | 'error' | undefined {
  if (!remoteModel) return 'unconfigured';
  const states = [remoteModel.llm.state, remoteModel.multimodal.state];
  if (states.some((s) => s === 'error')) return 'error';
  if (states.some((s) => s === 'running')) return 'running';
  return 'unconfigured';
}

function inferRemoteModelError(remoteModel: RemoteModelStatus | null): string | null {
  if (!remoteModel) return null;
  const errors = [remoteModel.llm.error, remoteModel.multimodal.error].filter(Boolean);
  return errors.length > 0 ? errors.join('; ') : null;
}
