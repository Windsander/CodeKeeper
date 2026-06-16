import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 1200,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 隐藏默认菜单栏（保留 Alt 键显示）
  win.setMenu(null);
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(null);
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else if (!app.isPackaged) {
    // 开发模式下未设置 VITE_DEV_SERVER_URL 时，默认连接 Vite dev server
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
