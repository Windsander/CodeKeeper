import type { IpcPushEvent } from '../../advance/ipc/types';

export interface ElectronAPI {
  invoke(method: string, params?: unknown): Promise<unknown>;
  onPush(callback: (event: IpcPushEvent) => void): () => void;
  openExternal(url: string): Promise<void>;
}

export function getAPI(): ElectronAPI {
  if (!window.electronAPI) {
    throw new Error('electronAPI 未在 preload 中暴露');
  }
  return window.electronAPI;
}

export async function invoke<T>(method: string, params?: unknown): Promise<T> {
  return getAPI().invoke(method, params) as Promise<T>;
}

export function onPush(callback: (event: IpcPushEvent) => void): () => void {
  return getAPI().onPush(callback);
}

export function openExternal(url: string): Promise<void> {
  return getAPI().openExternal(url);
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
