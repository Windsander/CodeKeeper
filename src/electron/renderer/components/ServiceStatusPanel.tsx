import { useState } from 'react';
import type { DaemonStatus, EverosStatus, LocalModelStatus, ModelServiceStatus } from '../../shared/service-status';

export interface ServiceStatusPanelProps {
  daemon: DaemonStatus | null;
  localModel: LocalModelStatus | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}

type NodeKey = 'daemon' | 'everos' | 'localModel' | 'embedding' | 'rerank';

interface StatusDisplay {
  label: string;
  badgeClass: string;
}

const STATE_DISPLAY: Record<ModelServiceStatus['state'], StatusDisplay> = {
  idle: { label: '闲置', badgeClass: 'badge-secondary' },
  starting: { label: '启动中', badgeClass: 'badge-info' },
  downloading: { label: '下载中', badgeClass: 'badge-warning' },
  loading: { label: '加载中', badgeClass: 'badge-info' },
  running: { label: '运行中', badgeClass: 'badge-success' },
  error: { label: '错误', badgeClass: 'badge-danger' },
};

const EVEROS_STATE_DISPLAY: Record<EverosStatus['state'], StatusDisplay> = {
  idle: { label: '闲置', badgeClass: 'badge-secondary' },
  starting: { label: '启动中', badgeClass: 'badge-info' },
  running: { label: '运行中', badgeClass: 'badge-success' },
  error: { label: '错误', badgeClass: 'badge-danger' },
};

const MAX_ERROR_LENGTH = 200;

function truncateError(message: string | null): { text: string; truncated: boolean } {
  if (!message) return { text: '', truncated: false };
  if (message.length <= MAX_ERROR_LENGTH) return { text: message, truncated: false };
  return { text: `${message.slice(0, MAX_ERROR_LENGTH)}...`, truncated: true };
}

function StatusBadge({ state, isDaemon = false, running }: { state?: string; isDaemon?: boolean; running?: boolean }) {
  let display: StatusDisplay;
  if (isDaemon) {
    display = running
      ? { label: '运行中', badgeClass: 'badge-success' }
      : { label: '未运行', badgeClass: 'badge-secondary' };
  } else if (state && state in STATE_DISPLAY) {
    display = STATE_DISPLAY[state as ModelServiceStatus['state']];
  } else {
    display = { label: state ?? '未知', badgeClass: 'badge-secondary' };
  }
  return <span className={`badge ${display.badgeClass}`}>{display.label}</span>;
}

interface TreeNodeProps {
  title: string;
  nodeKey: NodeKey;
  status: string | undefined;
  isDaemon?: boolean;
  running?: boolean;
  url?: string | null;
  error?: string | null;
  expandedKeys: Set<NodeKey>;
  onToggle: (key: NodeKey) => void;
  children?: React.ReactNode;
}

function TreeNode({
  title,
  nodeKey,
  status,
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
    <div className="service-status-node">
      <div
        className={`service-status-row ${hasError ? 'service-status-row--error' : ''}`}
        onClick={hasError ? () => onToggle(nodeKey) : undefined}
        role={hasError ? 'button' : undefined}
        tabIndex={hasError ? 0 : undefined}
      >
        <span className="service-status-title">{title}</span>
        <StatusBadge state={status} isDaemon={isDaemon} running={running} />
      </div>
      {url && status === 'running' && (
        <div className="service-status-url">{url}</div>
      )}
      {hasError && isExpanded && (
        <div className="service-status-error">
          {errorText}
          {truncated && <span className="service-status-error-hint">（查看日志获取完整信息）</span>}
        </div>
      )}
      {children && <div className="service-status-children">{children}</div>}
    </div>
  );
}

export function ServiceStatusPanel({ daemon, localModel, loading, error, onRefresh }: ServiceStatusPanelProps) {
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
        {onRefresh && (
          <button
            type="button"
            className="service-status-refresh"
            onClick={onRefresh}
            disabled={loading}
            title="刷新状态"
          >
            {loading ? '刷新中...' : '刷新'}
          </button>
        )}
      </div>
      {error && <div className="service-status-top-error">{error}</div>}
      <div className="service-status-tree">
        <TreeNode
          title="Daemon"
          nodeKey="daemon"
          isDaemon
          running={daemon?.daemonRunning ?? false}
          error={daemon?.everos?.state === 'error' ? daemon.everos.error ?? undefined : undefined}
          expandedKeys={expandedKeys}
          onToggle={toggle}
        >
          <TreeNode
            title="EverOS"
            nodeKey="everos"
            status={daemon?.everos?.state}
            url={daemon?.everos?.url}
            error={daemon?.everos?.error ?? undefined}
            expandedKeys={expandedKeys}
            onToggle={toggle}
          >
            <TreeNode
              title="本地模型服务"
              nodeKey="localModel"
              status={inferLocalModelState(localModel)}
              error={inferLocalModelError(localModel) ?? undefined}
              expandedKeys={expandedKeys}
              onToggle={toggle}
            >
              <TreeNode
                title="Embedding"
                nodeKey="embedding"
                status={localModel?.embedding.state}
                url={localModel?.embedding.url}
                error={localModel?.embedding.error ?? undefined}
                expandedKeys={expandedKeys}
                onToggle={toggle}
              />
              <TreeNode
                title="Rerank"
                nodeKey="rerank"
                status={localModel?.rerank.state}
                url={localModel?.rerank.url}
                error={localModel?.rerank.error ?? undefined}
                expandedKeys={expandedKeys}
                onToggle={toggle}
              />
            </TreeNode>
          </TreeNode>
        </TreeNode>
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
