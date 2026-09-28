import React from "react";
import { AVATARS, AvatarInfo, getAvatarById } from "../utils/avatars";

interface AvatarPickerProps {
  selectedAvatarId: string;
  onSelectAvatar: (id: string) => void;
}

export const AvatarPicker: React.FC<AvatarPickerProps> = ({ selectedAvatarId, onSelectAvatar }) => {
  const currentAvatar: AvatarInfo = getAvatarById(selectedAvatarId);

  const handleRandomize = () => {
    const available = AVATARS.filter((a) => a.id !== selectedAvatarId);
    const random = available[Math.floor(Math.random() * available.length)];
    if (random) {
      onSelectAvatar(random.id);
    }
  };

  return (
    <div className="avatar-picker-container">
      <div className="avatar-picker-header">
        <label className="avatar-picker-label">Choose Your Avatar</label>
        <button
          type="button"
          className="avatar-shuffle-btn"
          onClick={handleRandomize}
          title="Randomize Avatar"
        >
          🎲 Shuffle
        </button>
      </div>

      <div className="avatar-current-display">
        <div className="avatar-large-preview" style={{ backgroundColor: currentAvatar.bgColor }}>
          <span className="avatar-large-emoji">{currentAvatar.emoji}</span>
        </div>
        <div className="avatar-current-info">
          <span className="avatar-current-name">{currentAvatar.label}</span>
          <span className="avatar-current-hint">Pick an icon for lobby & chat</span>
        </div>
      </div>

      <div className="avatar-grid" role="radiogroup" aria-label="Avatar options">
        {AVATARS.map((avatar) => {
          const isSelected = avatar.id === selectedAvatarId;
          return (
            <button
              key={avatar.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`avatar-choice-btn ${isSelected ? "selected" : ""}`}
              onClick={() => onSelectAvatar(avatar.id)}
              title={avatar.label}
              style={{ backgroundColor: avatar.bgColor }}
            >
              <span className="avatar-choice-emoji">{avatar.emoji}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
