import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { TitleBar } from './components/TitleBar.js';
import { ThemeProvider } from './contexts/ThemeContext.js';
import { LayoutProvider, useLayout } from './contexts/LayoutContext.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { SidebarBrand } from './components/SidebarBrand.js';
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

function AppContent() {
  const location = useLocation();
  const { sidebarCollapsed } = useLayout();
  const isMemoryRoute = location.pathname === '/memory';

  return (
    <div className="app-layout" data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}>
      <TitleBar />
      <div className={`app-body${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <nav className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
          <SidebarBrand />

          {TOP_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              title={item.label}
            >
              <span className="sidebar-icon"><item.icon /></span>
              <span className="sidebar-label">{item.label}</span>
            </NavLink>
          ))}

          {getAllRoleUIs().map((ui) => {
            const Icon = ui.icon;
            return (
              <NavLink
                key={ui.role}
                to={ui.routePath}
                className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                title={ui.navLabel}
              >
                <span className="sidebar-icon"><Icon /></span>
                <span className="sidebar-label">{ui.navLabel}</span>
              </NavLink>
            );
          })}

          {BOTTOM_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              title={item.label}
            >
              <span className="sidebar-icon"><item.icon /></span>
              <span className="sidebar-label">{item.label}</span>
            </NavLink>
          ))}

          <SidebarToggle />
          <ThemeToggle />
        </nav>
        <main className={`main-content${isMemoryRoute ? ' memory-page-active' : ''}`}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/project/:id" element={<ProjectDetail />} />
            <Route path="/history" element={<ActionHistory />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/reviewer" element={<MrReview />} />
            <Route path="/maintainer" element={<Maintainer />} />
            <Route path="/memory" element={<MemoryGraphPage />} />
            <Route path="/memory-stats" element={<MemoryStatsPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
