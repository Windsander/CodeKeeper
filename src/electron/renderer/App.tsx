import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';

export function App() {
  return (
    <BrowserRouter>
      <div style={{ display: 'flex', height: '100vh' }}>
        <nav style={{ width: 200, borderRight: '1px solid #ccc', padding: 16 }}>
          <h2>CodeKeeper</h2>
          <div><Link to="/">仪表盘</Link></div>
        </nav>
        <main style={{ flex: 1, padding: 16, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<div>仪表盘占位</div>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
