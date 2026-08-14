interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
  reverse?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * iOS 风格 Toggle 开关
 */
export function Toggle({
  checked,
  onChange,
  children,
  reverse = false,
  ariaLabel,
  disabled = false,
  className = '',
}: ToggleProps) {
  return (
    <label
      className={`toggle ${reverse ? 'reverse' : ''} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} ${className}`.trim()}
    >
      <input
        type="checkbox"
        className="toggle-input"
        checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
      />
      {!reverse && (
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      )}
      {children !== undefined && children !== null && (
        <span className="toggle-label">{children}</span>
      )}
      {reverse && (
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      )}
    </label>
  );
}
