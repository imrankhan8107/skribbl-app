import { useEffect, useState, useCallback, useRef } from "react";
import { subscribeReaction } from "../context/reactionBus";
import type { ReactionEvent } from "../context/reactionBus";
import { soundManager } from "../utils/soundEffects";

export default function FloatingReactions() {
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const lastSoundTimeRef = useRef<number>(0);

  const removeReaction = useCallback((id: string) => {
    setReactions((prev) => prev.filter((r) => r.id !== id));
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeReaction((event) => {
      // Throttle audio so rapid reaction bursts don't clip
      const now = Date.now();
      if (now - lastSoundTimeRef.current > 120) {
        lastSoundTimeRef.current = now;
        soundManager.playReaction();
      }

      setReactions((prev) => [...prev.slice(-25), event]); // keep maximum 25 active particles
    });

    return unsubscribe;
  }, []);

  return (
    <div className="floating-reactions-overlay" data-testid="floating-reactions" aria-hidden="true">
      {reactions.map((r) => (
        <div
          key={r.id}
          className="floating-reaction-item"
          style={{ left: `${r.xPercent}%` }}
          onAnimationEnd={() => removeReaction(r.id)}
        >
          <span className="floating-emoji">{r.emoji}</span>
          {r.playerName && <span className="floating-sender">{r.playerName}</span>}
        </div>
      ))}
    </div>
  );
}
