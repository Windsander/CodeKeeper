import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { TitleBar } from './components/TitleBar';
import { Dashboard } from './pages/Dashboard';
import { ProjectDetail } from './pages/ProjectDetail';
import { ActionHistory } from './pages/ActionHistory';
import { Logs } from './pages/Logs';
import { Settings } from './pages/Settings';
import { MrReview } from './pages/MrReview';

export function App() {
  return (
    <BrowserRouter>
      <div className="app-layout">
        <TitleBar />
        <div className="app-body">
          <nav className="sidebar">
            <h2 className="sidebar-title">CodeKeeper</h2>
            <NavLink to="/" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
              仪表盘
            </NavLink>
            <NavLink to="/mr-review" className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}>
              MR 评审
            </NavLink>
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
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/project/:id" element={<ProjectDetail />} />
              <Route path="/history" element={<ActionHistory />} />
              <Route path="/logs" element={<Logs />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/mr-review" element={<MrReview />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}
