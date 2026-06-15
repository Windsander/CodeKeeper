import { app, ipcMain, shell, BrowserWindow } from 'electron';
import { createMainWindow } from './window-manager';
import { ElectronIpcClient } from './ipc-client';
import type { IpcPushEvent } from '../../advance/ipc/types';

const client = new ElectronIpcClient();
let mainWindow: BrowserWindow | null = null;

app.whenReady().then(async () => {
  await client.connect().catch(() => {
    console.warn('未能连接到守护进程，部分功能不可用');
  });

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  client.onPush((event: IpcPushEvent) => {
    mainWindow?.webContents.send('ipc-push', event);
  });

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
