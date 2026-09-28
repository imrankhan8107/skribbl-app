import React, { useState, useEffect, useRef } from "react";
import { THEMES, ThemeName, getStoredTheme, applyTheme } from "../utils/theme";

interface ThemeSelectorProps {
  className?: string;
}

export const ThemeSelector: React.FC<ThemeSelectorProps> = ({ className = "" }) => {
  const [currentTheme, setCurrentTheme] = useState<ThemeName>("light");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = getStoredTheme();
    setCurrentTheme(saved);
    applyTheme(saved);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleSelectTheme = (themeId: ThemeName) => {
    setCurrentTheme(themeId);
    applyTheme(themeId);
    setIsOpen(false);
  };

  const activeOption = THEMES.find((t) => t.id === currentTheme) || THEMES[0];

  return (
    <div className={`theme-selector-container ${className}`} ref={containerRef}>
      <button
        type="button"
        className="theme-selector-btn"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-label="Toggle theme selector"
        title={`Current Theme: ${activeOption.label}`}
      >
        <span className="theme-btn-icon">{activeOption.icon}</span>
        <span className="theme-btn-label">{activeOption.label}</span>
      </button>

      {isOpen && (
        <div className="theme-dropdown-menu" role="menu">
          <div className="theme-dropdown-header">Choose Theme</div>
          <div className="theme-options-grid">
            {THEMES.map((theme) => {
              const isSelected = theme.id === currentTheme;
              return (
                <button
                  key={theme.id}
                  type="button"
                  className={`theme-option-btn ${isSelected ? "selected" : ""}`}
                  onClick={() => handleSelectTheme(theme.id)}
                  role="menuitem"
                >
                  <div className="theme-option-preview">
                    <span
                      className="swatch swatch-primary"
                      style={{ backgroundColor: theme.previewColors[0] }}
                    />
                    <span
                      className="swatch swatch-bg"
                      style={{ backgroundColor: theme.previewColors[1] }}
                    />
                    <span
                      className="swatch swatch-accent"
                      style={{ backgroundColor: theme.previewColors[2] }}
                    />
                  </div>
                  <span className="theme-option-label">
                    {theme.icon} {theme.label}
                  </span>
                  {isSelected && <span className="theme-check">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
