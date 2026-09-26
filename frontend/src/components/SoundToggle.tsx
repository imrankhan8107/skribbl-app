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
      className={`inline-flex items-center justify-center p-2 rounded-lg transition-colors border text-sm font-medium ${
        muted
          ? "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200"
          : "bg-indigo-50 text-indigo-600 border-indigo-200 hover:bg-indigo-100"
      } ${className}`}
      title={muted ? "Unmute game sounds" : "Mute game sounds"}
      aria-label={muted ? "Unmute game sounds" : "Mute game sounds"}
    >
      <span className="text-base mr-1">{muted ? "🔇" : "🔊"}</span>
      <span className="hidden sm:inline">{muted ? "Muted" : "Sound On"}</span>
    </button>
  );
};
