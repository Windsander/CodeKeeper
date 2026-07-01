import { useTheme } from '../contexts/ThemeContext.js';

/**
 * 侧边栏主题切换按钮：暗色时显示太阳，亮色时显示月亮。
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      className="sidebar-link theme-toggle"
      onClick={toggleTheme}
      title={isDark ? '切换到亮色主题' : '切换到暗色主题'}
      aria-label={isDark ? '切换到亮色主题' : '切换到暗色主题'}
    >
      <span className="theme-toggle-icon">
        {isDark ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </span>
      <span className="theme-toggle-text">{isDark ? '切换亮色' : '切换暗色'}</span>
    </button>
  );
}
