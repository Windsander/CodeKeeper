import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { ProjectDetail } from './pages/ProjectDetail';
import { ActionHistory } from './pages/ActionHistory';

export function App() {
  return (
    <BrowserRouter>
      <div style={{ display: 'flex', height: '100vh' }}>
        <nav style={{ width: 200, borderRight: '1px solid #ccc', padding: 16 }}>
          <h2>CodeKeeper</h2>
          <div><Link to="/">仪表盘</Link></div>
          <div><Link to="/history">动作历史</Link></div>
        </nav>
        <main style={{ flex: 1, padding: 16, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/project/:id" element={<ProjectDetail />} />
            <Route path="/history" element={<ActionHistory />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
