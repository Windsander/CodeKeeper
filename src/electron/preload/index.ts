import { contextBridge, ipcRenderer } from 'electron';
import type { IpcPushEvent } from '../../advance/ipc/types';

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke('ipc-invoke', method, params),
  onPush: (callback: (event: IpcPushEvent) => void) => {
    const handler = (_event: unknown, data: IpcPushEvent) => callback(data);
    ipcRenderer.on('ipc-push', handler);
    return () => ipcRenderer.off('ipc-push', handler);
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
});
