import { useLayout } from '../contexts/LayoutContext.js';

export interface PageHeaderProps {
  /** 标题左侧图标（React 节点） */
  icon: React.ReactNode;
  /** 页面标题 */
  title: string;
  /** 刷新回调，未传入时不显示刷新按钮 */
  onRefresh?: () => void;
  /** 额外右侧元素（如服务控制按钮） */
  extra?: React.ReactNode;
}

/**
 * 统一页面标题栏：图标 + 标题 + 额外操作 + 刷新按钮。
 *
 * 在侧边栏展开时，标题栏通过 CSS 隐藏；收起时显示并 sticky 置顶。
 */
export function PageHeader({ icon, title, onRefresh, extra }: PageHeaderProps) {
  const { sidebarCollapsed } = useLayout();

  return (
    <header
      className={`page-header${sidebarCollapsed ? ' visible' : ''}`}
    >
      <div className="page-header-left">
        <div className="page-header-logo">{icon}</div>
        <h1 className="page-header-title">{title}</h1>
      </div>

      <div className="page-header-right">
        {extra}
        {onRefresh && (
          <button
            type="button"
            className="page-header-refresh"
            onClick={onRefresh}
            title="刷新"
          >
            ↻
          </button>
        )}
      </div>
    </header>
  );
}
