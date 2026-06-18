interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
}

/**
 * iOS 风格 Toggle 开关
 */
export function Toggle({ checked, onChange, children }: ToggleProps) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        className="toggle-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{children}</span>
    </label>
  );
}
