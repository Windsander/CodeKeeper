import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';

function getIconPath(): string | undefined {
  if (process.env.VITE_DEV_SERVER_URL || !app.isPackaged) {
    return join(app.getAppPath(), 'src/electron/renderer/public/icon.png');
  }
  return join(__dirname, '../renderer/icon.png');
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 1200,
    frame: false,
    titleBarStyle: 'hidden',
    icon: getIconPath(),
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

/** 独立日志窗口：复用渲染 bundle，但不显示主应用侧边栏。 */
export function createLogsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'CodeKeeper 日志',
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);

  const loadTarget =
    process.env.VITE_DEV_SERVER_URL || (!app.isPackaged && 'http://localhost:5173');
  if (loadTarget) {
    const url = new URL(loadTarget);
    url.searchParams.set('window', 'logs');
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'window=logs' });
  }
  return win;
}
