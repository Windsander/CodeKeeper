interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
  reverse?: boolean;
}

/**
 * iOS 风格 Toggle 开关
 */
export function Toggle({ checked, onChange, children, reverse = false }: ToggleProps) {
  return (
    <label className={`toggle ${reverse ? 'reverse' : ''}`}>
      <input
        type="checkbox"
        className="toggle-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {!reverse && (
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      )}
      <span className="toggle-label">{children}</span>
      {reverse && (
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
      )}
    </label>
  );
}
