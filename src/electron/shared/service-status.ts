/**
 * Daemon、EverOS、CodeGraph 与模型服务的状态类型。
 * 主进程与渲染进程共享此文件，避免 IPC 两端类型漂移。
 */

export type ModelServiceState = 'idle' | 'starting' | 'downloading' | 'loading' | 'running' | 'error';

export interface ModelServiceStatus {
  state: ModelServiceState;
  url: string | null;
  error: string | null;
  /** 下载进度 0-100，仅 downloading 时有效 */
  progress: number | null;
}

export type DaemonManagedServiceState = 'idle' | 'starting' | 'running' | 'error';

export type EverosServiceState = DaemonManagedServiceState;

export interface EverosStatus {
  state: EverosServiceState;
  url: string | null;
  error: string | null;
}

export type CodeGraphProviderState =
  | 'ready'
  | 'preparable'
  | 'preparing'
  | 'manual'
  | 'unavailable';

export interface CodeGraphProviderStatus {
  providerId: string;
  displayName: string;
  state: CodeGraphProviderState;
  prepared: boolean;
  version: string | null;
  message: string | null;
}

export interface CodeGraphServiceStatus {
  state: DaemonManagedServiceState;
  url: string | null;
  error: string | null;
  activeJobs: number;
  queuedJobs: number;
  providers: CodeGraphProviderStatus[];
}

export interface DaemonStatus {
  daemonRunning: boolean;
  everos: EverosStatus;
  codeGraph: CodeGraphServiceStatus;
}

export interface LocalModelStatus {
  embedding: ModelServiceStatus;
  rerank: ModelServiceStatus;
}

export interface RemoteModelItemStatus {
  state: 'unconfigured' | 'idle' | 'running' | 'error';
  modelLabel: string;
  fullModel: string;
  baseUrl: string | null;
  error: string | null;
  lastCheckedAt: number;
}

export interface RemoteModelStatus {
  llm: RemoteModelItemStatus;
  multimodal: RemoteModelItemStatus;
}
