import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  loading: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 主题上下文：管理明亮/暗黑主题，持久化通过 Electron IPC。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .invoke('theme.get')
      .then((saved) => {
        if (cancelled) return;
        const next = saved === 'light' ? 'light' : 'dark';
        setTheme(next);
        document.documentElement.dataset.theme = next;
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('读取主题配置失败，使用默认暗色主题', err);
        document.documentElement.dataset.theme = 'dark';
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      window.electronAPI.invoke('theme.set', { theme: next }).catch((err) => {
        console.warn('保存主题配置失败', err);
      });
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, loading }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * 在 ThemeProvider 内获取主题上下文。
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme 必须在 ThemeProvider 内使用');
  }
  return ctx;
}
