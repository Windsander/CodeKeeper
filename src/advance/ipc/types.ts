/**
 * IPC 消息类型定义
 *
 * 提供 CodeKeeper Advance 进程间通信的基础类型和类型守卫。
 */

/** IPC 请求消息 */
export interface IpcRequest {
  id: string;
  method: string;
  params?: unknown;
}

/** IPC 错误信息 */
export interface IpcError {
  code: string;
  message: string;
}

/** IPC 响应消息 */
export interface IpcResponse {
  id: string;
  result?: unknown;
  error?: IpcError;
}

/** IPC 主动推送事件 */
export interface IpcPushEvent {
  type: 'push';
  event: string;
  payload: unknown;
}

/** IPC 消息联合类型：响应或推送 */
export type IpcMessage = IpcResponse | IpcPushEvent;

/**
 * 类型守卫：判断消息是否为 IPC 响应
 * @param msg IPC 消息
 * @returns 是否为 IpcResponse
 */
export function isIpcResponse(msg: IpcMessage): msg is IpcResponse {
  return 'id' in msg;
}

/**
 * 类型守卫：判断消息是否为 IPC 推送事件
 * @param msg IPC 消息
 * @returns 是否为 IpcPushEvent
 */
export function isIpcPushEvent(msg: IpcMessage): msg is IpcPushEvent {
  return 'type' in msg && msg.type === 'push';
}
