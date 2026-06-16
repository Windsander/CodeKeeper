import { useEffect, useState } from 'react';
import { windowMinimize, windowMaximize, windowClose, onWindowStateChange } from '../api/electron-api';

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const unsubscribe = onWindowStateChange((state) => {
      setIsMaximized(state.isMaximized);
    });
    return unsubscribe;
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-icon">◆</span>
        <span className="titlebar-name">CodeKeeper Advance</span>
      </div>
      <div className="titlebar-drag" />
      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-btn titlebar-minimize"
          onClick={() => windowMinimize()}
          aria-label="最小化"
          title="最小化"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="1" y="5.5" width="10" height="1" rx="0.5" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-maximize"
          onClick={() => windowMaximize()}
          aria-label={isMaximized ? '还原' : '最大化'}
          title={isMaximized ? '还原' : '最大化'}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M3 1h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H3z" />
              <rect x="2" y="2" width="6" height="6" rx="0.5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <rect x="1" y="1.5" width="9" height="9" rx="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          onClick={() => windowClose()}
          aria-label="关闭"
          title="关闭"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M2.22 2.22a.75.75 0 0 1 1.06 0L6 4.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L7.06 6l2.72 2.72a.75.75 0 1 1-1.06 1.06L6 7.06l-2.72 2.72a.75.75 0 0 1-1.06-1.06L4.94 6 2.22 3.28a.75.75 0 0 1 0-1.06z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
