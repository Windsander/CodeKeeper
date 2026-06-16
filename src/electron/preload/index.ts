import { contextBridge, ipcRenderer } from 'electron';
import type { IpcPushEvent } from '../shared/types';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke('ipc-invoke', method, params),
  onPush: (callback: (event: IpcPushEvent) => void) => {
    const handler = (_event: unknown, data: IpcPushEvent) => callback(data);
    ipcRenderer.on('ipc-push', handler);
    return () => ipcRenderer.off('ipc-push', handler);
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  showOpenDialog: (options: { title?: string; defaultPath?: string; properties?: string[] }) =>
    ipcRenderer.invoke('show-open-dialog', options),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  onWindowStateChange: (callback: (state: { isMaximized: boolean }) => void) => {
    const handler = (_event: unknown, data: { isMaximized: boolean }) => callback(data);
    ipcRenderer.on('window-state-change', handler);
    return () => ipcRenderer.off('window-state-change', handler);
  },
});
