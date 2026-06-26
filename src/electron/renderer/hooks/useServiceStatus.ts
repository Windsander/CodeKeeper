import { useIpc } from './useIpc';
import type { DaemonStatus, LocalModelStatus, RemoteModelStatus } from '../../shared/service-status';

const POLL_INTERVAL_MS = 3000;

export interface ServiceStatusResult {
  daemon: DaemonStatus | null;
  localModel: LocalModelStatus | null;
  remoteModel: RemoteModelStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * 每 3 秒轮询 daemon.status、localModel.status 与 remoteModel.status，供右侧服务状态面板使用。
 * 页面不可见时自动停止轮询，切回前台立即刷新。
 */
export function useServiceStatus(): ServiceStatusResult {
  const {
    data: daemon,
    loading: daemonLoading,
    error: daemonError,
    refresh: refreshDaemon,
  } = useIpc<DaemonStatus>('daemon.status', undefined, { pollInterval: POLL_INTERVAL_MS });

  const {
    data: localModel,
    loading: localModelLoading,
    error: localModelError,
    refresh: refreshLocalModel,
  } = useIpc<LocalModelStatus>('localModel.status', undefined, { pollInterval: POLL_INTERVAL_MS });

  const {
    data: remoteModel,
    loading: remoteModelLoading,
    error: remoteModelError,
    refresh: refreshRemoteModel,
  } = useIpc<RemoteModelStatus>('remoteModel.status', undefined, { pollInterval: POLL_INTERVAL_MS });

  return {
    daemon: daemon ?? null,
    localModel: localModel ?? null,
    remoteModel: remoteModel ?? null,
    loading: daemonLoading || localModelLoading || remoteModelLoading,
    error: daemonError || localModelError || remoteModelError,
    refresh: () => {
      refreshDaemon();
      refreshLocalModel();
      refreshRemoteModel();
    },
  };
}
