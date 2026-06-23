import { useState, type ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
}

/**
 * 可折叠配置分组
 *
 * 点击标题可展开/收起内容，用于节省配置面板空间。
 */
export function CollapsibleSection({
  title,
  children,
  defaultExpanded = true,
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className={`config-section ${expanded ? 'expanded' : 'collapsed'}`}>
      <button
        type="button"
        className="config-section-header"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <h5 className="config-section-title">{title}</h5>
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
      </button>
      <div className="config-section-body">{children}</div>
    </div>
  );
}
