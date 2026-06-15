import { app, ipcMain, shell } from 'electron';
import { createMainWindow } from './window-manager';
import { ElectronIpcClient } from './ipc-client';
import type { IpcPushEvent } from '../../advance/ipc/types';

const client = new ElectronIpcClient();

app.whenReady().then(async () => {
  await client.connect().catch(() => {
    console.warn('未能连接到守护进程，部分功能不可用');
  });

  createMainWindow();

  ipcMain.handle('ipc-invoke', async (_event, method: string, params?: unknown) => {
    return client.invoke(method, params);
  });

  ipcMain.handle('open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });
});

app.on('window-all-closed', () => {
  client.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
