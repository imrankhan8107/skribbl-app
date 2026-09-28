import React, { useState } from "react";
import { ThemeSelector } from "./ThemeSelector";
import { SoundToggle } from "./SoundToggle";

interface HeaderBarProps {
  roomCode?: string | null;
  phase?: string;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({ roomCode, phase }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyCode = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header className="global-header-bar" role="banner">
      <div className="header-left">
        <a href="/" className="header-logo" title="Skribbl Home">
          <span className="logo-icon">✏️</span>
          <span className="logo-text">Skribbl</span>
        </a>
        {roomCode && (
          <button
            type="button"
            className="header-room-chip"
            onClick={handleCopyCode}
            title="Click to copy room code"
          >
            <span className="chip-label">Room:</span>
            <span className="chip-code">{roomCode}</span>
            <span className="chip-icon">{copied ? "✓" : "📋"}</span>
          </button>
        )}
        {phase && phase !== "idle" && (
          <span className="header-phase-badge">{phase.replace("_", " ").toUpperCase()}</span>
        )}
      </div>

      <div className="header-right">
        <ThemeSelector />
        <SoundToggle />
      </div>
    </header>
  );
};
