import { app, ipcMain, shell, BrowserWindow, dialog } from 'electron';
import { createMainWindow } from './window-manager';
import { ElectronIpcClient } from './ipc-client';
import { loadTheme, saveTheme } from './theme-persistence.js';
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
    // 主题相关调用由主进程本地处理，不转发给守护进程
    if (method === 'theme.get') {
      return loadTheme();
    }
    if (method === 'theme.set') {
      const { theme } = params as { theme: 'light' | 'dark' };
      saveTheme(theme === 'light' ? 'light' : 'dark');
      return { success: true };
    }

    if (!connected) {
      throw new Error('守护进程未连接');
    }
    return client.invoke(method, params);
  });

  ipcMain.handle('open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('theme.get', () => loadTheme());
  ipcMain.handle('theme.set', (_event, params: { theme: 'light' | 'dark' }) => {
    const theme = params.theme === 'light' ? 'light' : 'dark';
    saveTheme(theme);
    return { success: true };
  });

  ipcMain.handle('show-open-dialog', async (_event, options: {
    title?: string;
    defaultPath?: string;
    properties?: string[];
  }) => {
    const win = BrowserWindow.getFocusedWindow();
    const dialogOptions = {
      title: options.title,
      defaultPath: options.defaultPath,
      properties: (options.properties ?? ['openDirectory']) as Array<
        'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent'
      >,
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    return result;
  });

  ipcMain.handle('window-minimize', () => {
    const win = BrowserWindow.getFocusedWindow();
    win?.minimize();
  });

  ipcMain.handle('window-maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle('window-close', () => {
    const win = BrowserWindow.getFocusedWindow();
    win?.close();
  });

  function sendWindowState(win: BrowserWindow, isMaximized: boolean): void {
    win.webContents.send('window-state-change', { isMaximized });
  }

  mainWindow?.on('maximize', () => {
    if (mainWindow) sendWindowState(mainWindow, true);
  });
  mainWindow?.on('unmaximize', () => {
    if (mainWindow) sendWindowState(mainWindow, false);
  });
});

app.on('window-all-closed', () => {
  client.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
