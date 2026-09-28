import React, { useState } from "react";
import { soundManager } from "../utils/soundEffects";

interface SoundToggleProps {
  className?: string;
}

export const SoundToggle: React.FC<SoundToggleProps> = ({ className = "" }) => {
  const [muted, setMuted] = useState<boolean>(() => soundManager.isMuted());

  const handleToggle = () => {
    const nextMuted = soundManager.toggleMute();
    setMuted(nextMuted);
    // If unmuting, play a small confirmation chime
    if (!nextMuted) {
      soundManager.playCloseGuess();
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`sound-toggle-btn ${className}`}
      title={muted ? "Unmute game sounds" : "Mute game sounds"}
      aria-label={muted ? "Unmute game sounds" : "Mute game sounds"}
    >
      <span className="sound-btn-icon">{muted ? "🔇" : "🔊"}</span>
      <span className="sound-btn-label">{muted ? "Muted" : "Sound On"}</span>
    </button>
  );
};
