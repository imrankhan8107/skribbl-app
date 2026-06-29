import { useEffect, useState } from "react";

interface RoundTransitionProps {
  round: number;
  totalRounds: number;
  /** Set to true to trigger the animation */
  show: boolean;
  /** Called when animation completes */
  onComplete: () => void;
}

/**
 * Full-screen overlay that animates when a new round starts:
 * 1. Slides from bottom to center
 * 2. Pauses for 500ms
 * 3. Slides from center to top and exits
 */
export default function RoundTransition({
  round,
  totalRounds,
  show,
  onComplete,
}: RoundTransitionProps) {
  const [stage, setStage] = useState<"hidden" | "entering" | "paused" | "exiting">("hidden");

  useEffect(() => {
    if (!show) {
      setStage("hidden");
      return;
    }

    // Start entering
    setStage("entering");

    // After slide-up-to-center completes (400ms), pause
    const enterTimer = setTimeout(() => {
      setStage("paused");
    }, 400);

    // After pause (500ms), exit upward
    const pauseTimer = setTimeout(() => {
      setStage("exiting");
    }, 900); // 400 enter + 500 pause

    // After exit animation (400ms), hide and call onComplete
    const exitTimer = setTimeout(() => {
      setStage("hidden");
      onComplete();
    }, 1300); // 400 + 500 + 400

    return () => {
      clearTimeout(enterTimer);
      clearTimeout(pauseTimer);
      clearTimeout(exitTimer);
    };
  }, [show, onComplete]);

  if (stage === "hidden") return null;

  return (
    <div
      className={`round-transition-overlay round-transition-${stage}`}
      data-testid="round-transition"
    >
      <div className="round-transition-content">
        <span className="round-transition-label">Round</span>
        <span className="round-transition-number">
          {round} / {totalRounds}
        </span>
      </div>
    </div>
  );
}
