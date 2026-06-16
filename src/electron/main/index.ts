import { app, ipcMain, shell, BrowserWindow } from 'electron';
import { createMainWindow } from './window-manager';
import { ElectronIpcClient } from './ipc-client';
import type { IpcPushEvent } from '../shared/types';

const client = new ElectronIpcClient();
let mainWindow: BrowserWindow | null = null;
let connected = false;

async function connectWithRetry(maxAttempts = 30, intervalMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.connect();
      connected = true;
      console.log('已连接到守护进程');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`第 ${attempt}/${maxAttempts} 次连接守护进程失败: ${message}`);
      if (attempt === maxAttempts) {
        console.warn('未能连接到守护进程，部分功能不可用');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

app.whenReady().then(async () => {
  await connectWithRetry();

  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  client.onPush((event: IpcPushEvent) => {
    mainWindow?.webContents.send('ipc-push', event);
  });

  ipcMain.handle('ipc-invoke', async (_event, method: string, params?: unknown) => {
    if (!connected) {
      throw new Error('守护进程未连接');
    }
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
