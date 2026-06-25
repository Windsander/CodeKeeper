import { useState, type ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
  /** 受控展开状态 */
  expanded?: boolean;
  /** 受控模式下折叠/展开切换回调 */
  onToggle?: () => void;
  headerExtra?: ReactNode;
  tip?: string;
  disabled?: boolean;
  /** 是否允许折叠展开；false 时保持当前状态且点击不切换 */
  collapsible?: boolean;
}

/**
 * 可折叠配置分组
 *
 * 点击标题可展开/收起内容，用于节省配置面板空间。
 * 支持标题右侧附加元素（如状态标签）和禁用提示。
 * 支持受控与非受控两种模式。
 */
export function CollapsibleSection({
  title,
  children,
  defaultExpanded = true,
  expanded: controlledExpanded,
  onToggle,
  headerExtra,
  tip,
  disabled = false,
  collapsible = true,
}: CollapsibleSectionProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  const handleToggle = () => {
    if (!collapsible || disabled) return;
    if (isControlled) {
      onToggle?.();
    } else {
      setInternalExpanded((prev) => !prev);
    }
  };

  return (
    <div className={`config-section ${expanded ? 'expanded' : 'collapsed'} ${disabled ? 'disabled' : ''}`}>
      <button
        type="button"
        className={`config-section-header ${collapsible ? 'collapsible' : 'locked'}`}
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        <h5 className="config-section-title">{title}</h5>
        <div className="config-section-header-extra">
          {headerExtra}
          <span className="config-section-arrow">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </div>
      </button>
      {tip && <div className="config-section-tip">{tip}</div>}
      <div className="config-section-body">{children}</div>
    </div>
  );
}
