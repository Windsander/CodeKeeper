import type { IpcPushEvent } from '../../shared/types';

export interface ElectronAPI {
  invoke(method: 'theme.get'): Promise<'light' | 'dark'>;
  invoke(method: 'theme.set', params: { theme: 'light' | 'dark' }): Promise<{ success: boolean }>;
  invoke(method: string, params?: unknown): Promise<unknown>;
  onPush(callback: (event: IpcPushEvent) => void): () => void;
  openExternal(url: string): Promise<void>;
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    properties?: string[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  onWindowStateChange(callback: (state: { isMaximized: boolean }) => void): () => void;
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

export function showOpenDialog(options: {
  title?: string;
  defaultPath?: string;
  properties?: string[];
}): Promise<{ canceled: boolean; filePaths: string[] }> {
  return getAPI().showOpenDialog(options);
}

export function windowMinimize(): Promise<void> {
  return getAPI().windowMinimize();
}

export function windowMaximize(): Promise<void> {
  return getAPI().windowMaximize();
}

export function windowClose(): Promise<void> {
  return getAPI().windowClose();
}

export function onWindowStateChange(callback: (state: { isMaximized: boolean }) => void): () => void {
  return getAPI().onWindowStateChange(callback);
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
