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
  HistoryIcon,
  LogsIcon,
  SettingsIcon,
} from './components/icons.js';
import { Dashboard } from './pages/Dashboard.js';
import { ProjectDetail } from './pages/ProjectDetail.js';
import { ActionHistory } from './pages/ActionHistory.js';
import { Logs } from './pages/Logs.js';
import { Settings } from './pages/Settings.js';
import { MrReview } from './pages/MrReview.js';
import { Maintainer } from './pages/Maintainer.js';
import { MemoryStatsPage } from './pages/MemoryStatsPage.js';
import { MemoryGraphPage } from './pages/MemoryGraphPage.js';
import { getAllRoleUIs } from './roles/role-registry.js';
// 触发角色 UI 注册（side-effect）
import './roles/reviewer-role.js';
import './roles/maintainer-role.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType;
}

/** 位于角色导航之前的顶部功能入口 */
const TOP_NAV_ITEMS: NavItem[] = [
  { to: '/', label: '仪表盘', icon: DashboardIcon },
  { to: '/memory', label: '记忆图谱', icon: MemoryGraphIcon },
  { to: '/memory-stats', label: '记忆统计', icon: MemoryStatsIcon },
];

/** 位于角色导航之后的底部功能入口 */
const BOTTOM_NAV_ITEMS: NavItem[] = [
  { to: '/history', label: '动作历史', icon: HistoryIcon },
  { to: '/logs', label: '日志', icon: LogsIcon },
  { to: '/settings', label: '设置', icon: SettingsIcon },
];

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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {sidebarCollapsed ? (
            <path d="M9 18l6-6-6-6" />
          ) : (
            <path d="M15 18l-6-6 6-6" />
          )}
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
  const isMemoryRoute = location.pathname === '/memory';

  const { daemon, localModel, loading } = useServiceStatus();
  const isReady =
    !loading &&
    daemon?.daemonRunning === true &&
    daemon?.everos?.state === 'running' &&
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
  }, [isReady]);

  return (
    <div className="app-layout" data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}>
      <TitleBar />
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
      <div className={`app-body${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <SidebarBrand />

          {TOP_NAV_ITEMS.map((item) => (
            <NavItemWithReady key={item.to} item={item} isReady={isReady} />
          ))}

          {getAllRoleUIs().map((ui) => {
            const Icon = ui.icon;
            return (
              <NavItemWithReady
                key={ui.role}
                item={{ to: ui.routePath, label: ui.navLabel, icon: Icon }}
                isReady={isReady}
              />
            );
          })}

          {BOTTOM_NAV_ITEMS.map((item) => (
            <NavItemWithReady key={item.to} item={item} isReady={isReady} />
          ))}

          <SidebarToggle />
          <ThemeToggle />
        </nav>
        <main className={`main-content${isMemoryRoute ? ' memory-page-active' : ''}`}>
          <Routes>
            <Route path="/" element={<DefaultRoute isReady={isReady} />} />
            <Route path="/project/:id" element={<ReadyGuard isReady={isReady}><ProjectDetail /></ReadyGuard>} />
            <Route path="/history" element={<ReadyGuard isReady={isReady}><ActionHistory /></ReadyGuard>} />
            <Route path="/logs" element={<ReadyGuard isReady={isReady}><Logs /></ReadyGuard>} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/reviewer" element={<ReadyGuard isReady={isReady}><MrReview /></ReadyGuard>} />
            <Route path="/maintainer" element={<ReadyGuard isReady={isReady}><Maintainer /></ReadyGuard>} />
            <Route path="/memory" element={<ReadyGuard isReady={isReady}><MemoryGraphPage /></ReadyGuard>} />
            <Route path="/memory-stats" element={<ReadyGuard isReady={isReady}><MemoryStatsPage /></ReadyGuard>} />
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
        <span className="sidebar-icon"><item.icon /></span>
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
      <span className="sidebar-icon"><item.icon /></span>
      <span className="sidebar-label">{item.label}</span>
    </NavLink>
  );
}
