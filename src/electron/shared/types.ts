/**
 * Electron 渲染进程与主进程共享的类型定义
 * 注意：这些类型与 src/advance 中的类型保持同步，避免 Electron tsconfig 引用 advance 源文件。
 */

export interface IpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface IpcError {
  code: string;
  message: string;
}

export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: IpcError;
}

export interface IpcPushEvent {
  type: 'push';
  event: string;
  payload: unknown;
}

export type IpcMessage = IpcResponse | IpcPushEvent;

export function isIpcResponse(msg: IpcMessage): msg is IpcResponse {
  return 'id' in msg;
}

export function isIpcPushEvent(msg: IpcMessage): msg is IpcPushEvent {
  return 'type' in msg && msg.type === 'push';
}

export type ArchiveActionType = 'copy' | 'organize' | 'ignore' | 'flag';

export interface ArchiveAction {
  id: string;
  sourcePath: string;
  type: ArchiveActionType;
  reason: string;
  targetPath?: string;
  relatedEntryId?: string;
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  createdAt: number;
}

export interface ProjectStatus {
  schemaVersion: number;
  projectId: string;
  lastScannedAt: number;
  lastScannedAtIso: string;
  scanStatus: 'success' | 'partial' | 'failed';
  totalCount: number;
  pendingCount: number;
  archivedCount: number;
  ignoredCount: number;
  orphanedCount: number;
  copiedCount: number;
  organizedCount: number;
  flaggedCount: number;
  healthScore: number;
  healthScoreDefinition: string;
}
