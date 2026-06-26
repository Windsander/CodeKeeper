interface CircularProgressProps {
  value?: number | null;
  size?: number;
  strokeWidth?: number;
}

export function CircularProgress({ value, size = 16, strokeWidth = 2 }: CircularProgressProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = value != null ? circumference - (value / 100) * circumference : circumference * 0.75;

  return (
    <svg width={size} height={size} className="circular-progress">
      <circle
        className="circular-progress-track"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
      />
      <circle
        className={`circular-progress-bar ${value == null ? 'circular-progress-bar--indeterminate' : ''}`}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
    </svg>
  );
}
