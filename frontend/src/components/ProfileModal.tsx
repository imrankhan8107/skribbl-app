import React, { useState } from "react";
import { AvatarPicker } from "./AvatarPicker";
import { getStoredAvatarId } from "../utils/avatars";

export interface ProfileModalProps {
  currentName: string;
  currentAvatarId?: string;
  onSave: (name: string, avatarId: string) => void;
  onClose: () => void;
}

export default function ProfileModal({
  currentName,
  currentAvatarId,
  onSave,
  onClose,
}: ProfileModalProps) {
  const [name, setName] = useState(currentName);
  const [avatarId, setAvatarId] = useState(currentAvatarId || getStoredAvatarId());
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setError("Name cannot be empty");
      return;
    }
    if (cleanName.length > 20) {
      setError("Name must be 20 characters or fewer");
      return;
    }
    setError(null);
    onSave(cleanName, avatarId);
    onClose();
  };

  return (
    <div
      className="gallery-modal-backdrop profile-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      data-testid="profile-modal"
    >
      <div
        className="gallery-modal-content profile-modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gallery-modal-header">
          <div>
            <h3 className="gallery-modal-word">🎨 Edit Profile</h3>
            <span className="gallery-modal-sub">
              Change your display name and avatar right in the lobby!
            </span>
          </div>
          <button
            type="button"
            className="gallery-modal-close"
            onClick={onClose}
            aria-label="Close"
            data-testid="profile-modal-close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="profile-modal-body">
            <div className="profile-name-field">
              <label htmlFor="profile-name-input" className="profile-field-label">
                Display Name
              </label>
              <input
                id="profile-name-input"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                maxLength={20}
                placeholder="Enter your name"
                className="profile-name-input"
                data-testid="profile-name-input"
                autoFocus
              />
              {error && (
                <div className="profile-error" data-testid="profile-error">
                  {error}
                </div>
              )}
            </div>

            <AvatarPicker selectedAvatarId={avatarId} onSelectAvatar={setAvatarId} />
          </div>

          <div className="profile-modal-footer">
            <button
              type="button"
              className="profile-btn cancel"
              onClick={onClose}
              data-testid="profile-cancel-btn"
            >
              Cancel
            </button>
            <button type="submit" className="profile-btn save" data-testid="profile-save-btn">
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
