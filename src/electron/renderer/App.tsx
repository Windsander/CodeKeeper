import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { TitleBar } from './components/TitleBar';
import { Dashboard } from './pages/Dashboard';
import { ProjectDetail } from './pages/ProjectDetail';
import { ActionHistory } from './pages/ActionHistory';
import { Logs } from './pages/Logs';
import { Settings } from './pages/Settings';
import { MrReview } from './pages/MrReview';
import { Maintainer } from './pages/Maintainer';
import { MemoryGraphPage } from './pages/MemoryGraphPage';
import { getAllRoleUIs } from './roles/role-registry.js';
// 触发角色 UI 注册（side-effect）
import './roles/reviewer-role.js';
import './roles/maintainer-role.js';

export function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

function AppContent() {
  const location = useLocation();
  const isMemoryPage = location.pathname === '/memory';

  return (
    <div className="app-layout">
      <TitleBar />
      <div className="app-body">
        <nav className="sidebar">
          <h2 className="sidebar-title">CodeKeeper</h2>
          <NavLink to="/" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
            仪表盘
          </NavLink>
          <NavLink to="/memory" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
            记忆图谱
          </NavLink>
          {getAllRoleUIs().map((ui) => (
            <NavLink
              key={ui.role}
              to={ui.routePath}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              {ui.navLabel}
            </NavLink>
          ))}
          <NavLink to="/history" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
            动作历史
          </NavLink>
          <NavLink to="/logs" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
            日志
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
            设置
          </NavLink>
        </nav>
        <main className={`main-content${isMemoryPage ? ' memory-page-active' : ''}`}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/project/:id" element={<ProjectDetail />} />
            <Route path="/history" element={<ActionHistory />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/reviewer" element={<MrReview />} />
            <Route path="/maintainer" element={<Maintainer />} />
            <Route path="/memory" element={<MemoryGraphPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
