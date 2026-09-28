import { useState, useRef, useCallback } from "react";

export interface ReactionEmojiOption {
  emoji: string;
  label: string;
}

export const REACTION_EMOJIS: ReactionEmojiOption[] = [
  { emoji: "👏", label: "Clap" },
  { emoji: "😂", label: "Haha" },
  { emoji: "🔥", label: "Fire" },
  { emoji: "🤯", label: "Mind Blown" },
  { emoji: "❤️", label: "Love" },
  { emoji: "💩", label: "Poop" },
  { emoji: "🎨", label: "Art" },
  { emoji: "⚡", label: "Fast" },
];

interface ReactionToolbarProps {
  onReact: (emoji: string) => void;
  disabled?: boolean;
}

export default function ReactionToolbar({ onReact, disabled = false }: ReactionToolbarProps) {
  const [activeEmoji, setActiveEmoji] = useState<string | null>(null);
  const lastSentTimeRef = useRef<number>(0);

  const handleClick = useCallback(
    (emoji: string) => {
      if (disabled) return;
      const now = Date.now();
      // Throttle network dispatch to 150ms per reaction
      if (now - lastSentTimeRef.current < 150) return;
      lastSentTimeRef.current = now;

      setActiveEmoji(emoji);
      setTimeout(() => setActiveEmoji(null), 250);

      onReact(emoji);
    },
    [disabled, onReact]
  );

  return (
    <div
      className="reaction-toolbar"
      data-testid="reaction-toolbar"
      role="toolbar"
      aria-label="Reaction emojis"
    >
      <span className="reaction-toolbar-title">React:</span>
      <div className="reaction-buttons-group">
        {REACTION_EMOJIS.map(({ emoji, label }) => {
          const isPopping = activeEmoji === emoji;
          return (
            <button
              key={emoji}
              type="button"
              className={`reaction-btn ${isPopping ? "popping" : ""}`}
              onClick={() => handleClick(emoji)}
              disabled={disabled}
              title={label}
              aria-label={label}
              data-testid={`reaction-btn-${label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <span className="reaction-emoji-glyph">{emoji}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
