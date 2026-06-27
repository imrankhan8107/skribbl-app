interface TimerBarProps {
  seconds: number;
  total: number;
}

/**
 * TimerBar — CSS-animated countdown progress bar.
 * Accepts `seconds` (remaining) and `total` (full duration).
 * Requirements: 12.4
 */
export default function TimerBar({ seconds, total }: TimerBarProps) {
  const percentage = total > 0 ? (seconds / total) * 100 : 0;

  // Determine urgency color based on remaining time ratio
  const getBarColor = (): string => {
    if (percentage > 50) return "#4caf50"; // green
    if (percentage > 25) return "#ff9800"; // orange
    return "#f44336"; // red
  };

  return (
    <div className="timer-bar" data-testid="timer-bar" aria-label="Turn timer">
      <div
        className="timer-bar-fill"
        data-testid="timer-bar-fill"
        style={{
          width: `${percentage}%`,
          backgroundColor: getBarColor(),
          height: "100%",
          borderRadius: "4px",
          transition: "width 1s linear",
        }}
      />
      <span className="timer-bar-text" data-testid="timer-bar-text">
        {seconds}s
      </span>
    </div>
  );
}
