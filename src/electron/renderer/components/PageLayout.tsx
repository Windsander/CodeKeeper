import { PageHeader, type PageHeaderProps } from './PageHeader.js';

interface PageLayoutProps extends PageHeaderProps {
  children: React.ReactNode;
}

/**
 * 标准功能页布局：顶部标题栏 + 可滚动内容区。
 *
 * 标题栏固定在内容区上方，不参与下方滚动，避免滚动条覆盖标题。
 */
export function PageLayout({ children, ...headerProps }: PageLayoutProps) {
  return (
    <div className="page-layout">
      <PageHeader {...headerProps} />
      <div className="page-layout-body">{children}</div>
    </div>
  );
}
