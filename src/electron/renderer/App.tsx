import { BrowserRouter, Routes, Route, NavLink, useLocation, Navigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar.js';
import { ThemeProvider } from './contexts/ThemeContext.js';
import { LayoutProvider, useLayout } from './contexts/LayoutContext.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { SidebarBrand } from './components/SidebarBrand.js';
import { useServiceStatus } from './hooks/useServiceStatus.js';
import {
  DashboardIcon,
  MemoryGraphIcon,
  MemoryStatsIcon,
  SettingsIcon,
} from './components/icons.js';
import { Dashboard } from './pages/Dashboard.js';
import { ProjectDetail } from './pages/ProjectDetail.js';
import { Settings } from './pages/Settings.js';
import { KnowledgeHubPage } from './pages/KnowledgeHubPage.js';
import { SystemStatusPage } from './pages/SystemStatusPage.js';
import { Logs } from './pages/Logs.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType;
}

/** 全局一级导航：项目、智库与运行基础设施 */
const TOP_NAV_ITEMS: NavItem[] = [
  { to: '/', label: '仪表盘', icon: DashboardIcon },
  { to: '/knowledge', label: '智库', icon: MemoryGraphIcon },
  { to: '/system', label: '系统状态', icon: MemoryStatsIcon },
];

/** 底部配置入口 */
const BOTTOM_NAV_ITEMS: NavItem[] = [{ to: '/settings', label: '设置', icon: SettingsIcon }];

/** 简单 Toast 组件 */
function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="app-toast" role="status" aria-live="polite">
      <span className="app-toast-message">{message}</span>
      <button type="button" className="app-toast-close" onClick={onClose} aria-label="关闭提示">
        ×
      </button>
    </div>
  );
}

export function App() {
  const isLogsWindow = new URLSearchParams(window.location.search).get('window') === 'logs';
  if (isLogsWindow) {
    return (
      <ThemeProvider>
        <LayoutProvider>
          <Logs />
        </LayoutProvider>
      </ThemeProvider>
    );
  }
  return (
    <BrowserRouter>
      <ThemeProvider>
        <LayoutProvider>
          <AppContent />
        </LayoutProvider>
      </ThemeProvider>
    </BrowserRouter>
  );
}

function SidebarToggle() {
  const { sidebarCollapsed, toggleSidebar } = useLayout();
  return (
    <button
      type="button"
      className="sidebar-link sidebar-toggle"
      onClick={toggleSidebar}
      title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
      aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
    >
      <span className="sidebar-toggle-icon">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {sidebarCollapsed ? <path d="M9 18l6-6-6-6" /> : <path d="M15 18l-6-6 6-6" />}
        </svg>
      </span>
      <span className="sidebar-toggle-text">{sidebarCollapsed ? '展开' : '收起'}</span>
    </button>
  );
}

function DefaultRoute({ isReady }: { isReady: boolean }) {
  return isReady ? <Dashboard /> : <Navigate to="/settings" replace />;
}

function ReadyGuard({ isReady, children }: { isReady: boolean; children: React.ReactNode }) {
  return isReady ? <>{children}</> : <Navigate to="/settings" replace />;
}

function AppContent() {
  const location = useLocation();
  const { sidebarCollapsed } = useLayout();
  const isMemoryRoute = location.pathname === '/knowledge';

  const { daemon, localModel, loading } = useServiceStatus();
  const isReady =
    !loading &&
    daemon?.daemonRunning === true &&
    daemon?.everos?.state === 'running' &&
    daemon?.codeGraph?.state === 'running' &&
    localModel?.embedding?.state === 'running' &&
    localModel?.rerank?.state === 'running';

  const [toast, setToast] = useState<string | null>(null);
  const prevReadyRef = useRef(isReady);

  useEffect(() => {
    if (!prevReadyRef.current && isReady) {
      setToast('所有本地服务已就绪，可以开始使用');
      const id = setTimeout(() => setToast(null), 10000);
      return () => clearTimeout(id);
    }
    prevReadyRef.current = isReady;
    return undefined;
  }, [isReady]);

  return (
    <div className="app-layout" data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}>
      <TitleBar />
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
      <div className={`app-body${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <SidebarBrand />

          {TOP_NAV_ITEMS.map(item => (
            <NavItemWithReady key={item.to} item={item} isReady={isReady} />
          ))}

          {BOTTOM_NAV_ITEMS.map(item => (
            <NavItemWithReady key={item.to} item={item} isReady={isReady} />
          ))}

          <SidebarToggle />
          <ThemeToggle />
        </nav>
        <main className={`main-content${isMemoryRoute ? ' memory-page-active' : ''}`}>
          <Routes>
            <Route path="/" element={<DefaultRoute isReady={isReady} />} />
            <Route
              path="/project/:id"
              element={
                <ReadyGuard isReady={isReady}>
                  <ProjectDetail />
                </ReadyGuard>
              }
            />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/knowledge"
              element={
                <ReadyGuard isReady={isReady}>
                  <KnowledgeHubPage />
                </ReadyGuard>
              }
            />
            <Route
              path="/system"
              element={
                <ReadyGuard isReady={isReady}>
                  <SystemStatusPage />
                </ReadyGuard>
              }
            />
            <Route path="/memory" element={<Navigate to="/knowledge" replace />} />
            <Route path="/memory-stats" element={<Navigate to="/knowledge" replace />} />
            <Route path="/reviewer" element={<Navigate to="/" replace />} />
            <Route path="/maintainer" element={<Navigate to="/" replace />} />
            <Route path="/archiver" element={<Navigate to="/" replace />} />
            <Route path="/history" element={<Navigate to="/" replace />} />
            <Route path="/logs" element={<Navigate to="/settings" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function NavItemWithReady({ item, isReady }: { item: NavItem; isReady: boolean }) {
  const isSettings = item.to === '/settings';
  const disabled = !isSettings && !isReady;

  if (disabled) {
    return (
      <span
        className="sidebar-link disabled"
        title="本地服务启动中，就绪后可用"
        aria-disabled="true"
      >
        <span className="sidebar-icon">
          <item.icon />
        </span>
        <span className="sidebar-label">{item.label}</span>
      </span>
    );
  }

  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
      title={item.label}
    >
      <span className="sidebar-icon">
        <item.icon />
      </span>
      <span className="sidebar-label">{item.label}</span>
    </NavLink>
  );
}
