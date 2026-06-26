/**
 * Daemon、EverOS 与本地模型服务的状态类型。
 * 主进程与渲染进程共享此文件，避免 IPC 两端类型漂移。
 */

export type ModelServiceState = 'idle' | 'starting' | 'downloading' | 'loading' | 'running' | 'error';

export interface ModelServiceStatus {
  state: ModelServiceState;
  url: string | null;
  error: string | null;
}

export type EverosServiceState = 'idle' | 'starting' | 'running' | 'error';

export interface EverosStatus {
  state: EverosServiceState;
  url: string | null;
  error: string | null;
}

export interface DaemonStatus {
  daemonRunning: boolean;
  everos: EverosStatus;
}

export interface LocalModelStatus {
  embedding: ModelServiceStatus;
  rerank: ModelServiceStatus;
}
