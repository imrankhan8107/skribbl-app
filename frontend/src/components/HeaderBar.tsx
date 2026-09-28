import React from "react";
import { ThemeSelector } from "./ThemeSelector";
import { SoundToggle } from "./SoundToggle";

interface HeaderBarProps {
  roomCode?: string | null;
  phase?: string;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({ phase }) => {
  return (
    <header className="global-header-bar" role="banner">
      <div className="header-left">
        <a href="/" className="header-logo" title="Skribbl Home">
          <span className="logo-icon">✏️</span>
          <span className="logo-text">Skribbl</span>
        </a>
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
