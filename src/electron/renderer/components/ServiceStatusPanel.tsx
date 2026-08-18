import { useState } from 'react';
import type {
  CodeGraphProviderStatus,
  DaemonStatus,
  LocalModelStatus,
  ModelServiceStatus,
  RemoteModelStatus,
} from '../../shared/service-status';
import { CircularProgress } from './CircularProgress';

export interface ServiceStatusPanelProps {
  daemon: DaemonStatus | null;
  localModel: LocalModelStatus | null;
  remoteModel: RemoteModelStatus | null;
}

type NodeKey = string;

interface StatusDisplay {
  label: string;
  badgeClass: string;
  dotClass: string;
}

const STATE_DISPLAY: Record<string, StatusDisplay> = {
  idle: { label: '闲置', badgeClass: 'badge-secondary', dotClass: 'status-dot-idle' },
  starting: { label: '启动中', badgeClass: 'badge-info', dotClass: 'status-dot-starting' },
  downloading: { label: '下载中', badgeClass: 'badge-warning', dotClass: 'status-dot-downloading' },
  loading: { label: '加载中', badgeClass: 'badge-info', dotClass: 'status-dot-loading' },
  running: { label: '运行中', badgeClass: 'badge-success', dotClass: 'status-dot-running' },
  error: { label: '错误', badgeClass: 'badge-danger', dotClass: 'status-dot-error' },
  ready: { label: '就绪', badgeClass: 'badge-success', dotClass: 'status-dot-running' },
  preparable: { label: '待准备', badgeClass: 'badge-secondary', dotClass: 'status-dot-idle' },
  preparing: { label: '准备中', badgeClass: 'badge-info', dotClass: 'status-dot-starting' },
  manual: { label: '需 Agent', badgeClass: 'badge-warning', dotClass: 'status-dot-downloading' },
  unavailable: { label: '不可用', badgeClass: 'badge-danger', dotClass: 'status-dot-error' },
  unconfigured: { label: '未配置', badgeClass: 'badge-secondary', dotClass: 'status-dot-idle' },
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
    display = STATE_DISPLAY[state];
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
  detail?: string | null;
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
  detail,
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
        {status === 'downloading' && progress != null && (
          <span className="service-status-progress">
            <CircularProgress value={progress} size={14} strokeWidth={2} />
          </span>
        )}
        <StatusBadge state={status} isDaemon={isDaemon} running={running} />
      </div>
      {url && status === 'running' && (
        <div className="service-status-url">{url}</div>
      )}
      {detail && <div className={'service-status-meta'}>{detail}</div>}
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

export function ServiceStatusPanel({ daemon, localModel, remoteModel }: ServiceStatusPanelProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<NodeKey>>(new Set());

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
      </div>
      <div className="service-status-body">
        <div className="service-status-tree">
            <TreeNode
              title="Daemon"
              nodeKey="daemon"
              icon="🖥️"
              isDaemon
              running={daemon?.daemonRunning ?? false}
              error={inferDaemonError(daemon)}
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
                title={'代码图谱服务'}
                nodeKey={'codeGraph'}
                icon={'🕸️'}
                status={daemon?.codeGraph.state}
                url={daemon?.codeGraph.url}
                detail={formatCodeGraphJobStatus(daemon)}
                error={daemon?.codeGraph.error ?? null}
                expandedKeys={expandedKeys}
                onToggle={toggle}
              >
                {daemon?.codeGraph.providers.map(provider => (
                  <TreeNode
                    key={provider.providerId}
                    title={provider.displayName}
                    nodeKey={`codeGraph-provider-${provider.providerId}`}
                    icon={'◈'}
                    status={provider.state}
                    detail={formatCodeGraphProviderDetail(provider)}
                    error={provider.state === 'unavailable' ? provider.message : null}
                    expandedKeys={expandedKeys}
                    onToggle={toggle}
                  />
                ))}
              </TreeNode>
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
                    url={remoteModel.llm.baseUrl}
                    error={remoteModel.llm.error ?? null}
                    expandedKeys={expandedKeys}
                    onToggle={toggle}
                  />
                  <TreeNode
                    title={remoteModel.multimodal.modelLabel}
                    nodeKey="remoteModel-multimodal"
                    icon="🖼️"
                    status={remoteModel.multimodal.state}
                    url={remoteModel.multimodal.baseUrl}
                    error={remoteModel.multimodal.error ?? null}
                    expandedKeys={expandedKeys}
                    onToggle={toggle}
                  />
                </TreeNode>
              )}
            </TreeNode>
          </div>
      </div>
    </div>
  );
}

function inferDaemonError(daemon: DaemonStatus | null): string | null {
  if (!daemon) return null;
  return [daemon.everos.error, daemon.codeGraph.error].filter(Boolean).join('; ') || null;
}

function formatCodeGraphJobStatus(daemon: DaemonStatus | null): string | null {
  if (!daemon) return null;
  return `活跃任务 ${daemon.codeGraph.activeJobs} · 排队 ${daemon.codeGraph.queuedJobs}`;
}

function formatCodeGraphProviderDetail(provider: CodeGraphProviderStatus): string | null {
  const parts = [provider.version ? `v${provider.version}` : '', provider.message ?? ''].filter(Boolean);
  return parts.join(' · ') || null;
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
