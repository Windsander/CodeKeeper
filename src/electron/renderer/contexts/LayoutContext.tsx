import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface LayoutContextValue {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

interface LayoutProviderProps {
  children: ReactNode;
  initialCollapsed?: boolean;
}

/**
 * 布局上下文：管理侧边栏展开/收起状态。
 */
export function LayoutProvider({ children, initialCollapsed = false }: LayoutProviderProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialCollapsed);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  return (
    <LayoutContext.Provider value={{ sidebarCollapsed, toggleSidebar }}>
      {children}
    </LayoutContext.Provider>
  );
}

/**
 * 在 LayoutProvider 内获取布局上下文。
 */
export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) {
    throw new Error('useLayout 必须在 LayoutProvider 内使用');
  }
  return ctx;
}
