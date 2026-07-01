import { useLayout } from '../contexts/LayoutContext.js';

/**
 * 侧边栏顶部品牌标识：
 * - 展开时显示 CodeKeeper 文字
 * - 收起时显示 CK 缩写标记
 *
 * 两个文本叠加并通过 opacity 过渡，避免切换时跳动。
 */
export function SidebarBrand() {
  const { sidebarCollapsed } = useLayout();

  return (
    <div className="sidebar-brand" data-collapsed={sidebarCollapsed}>
      <span className="sidebar-brand-text">CodeKeeper</span>
      <span className="sidebar-brand-mark">CK</span>
    </div>
  );
}
