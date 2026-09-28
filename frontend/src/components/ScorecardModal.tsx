import { useState, useMemo } from "react";
import type { PlayerInfo, MvpAward } from "../types";
import { generateScorecardCanvas, downloadScorecard, copyScorecardImage } from "../utils/shareCard";
import { copyToClipboard } from "../utils/clipboard";

export interface ScorecardModalProps {
  roomCode?: string | null;
  players: PlayerInfo[];
  mvpAwards?: MvpAward[];
  onClose: () => void;
}

export default function ScorecardModal({
  roomCode,
  players,
  mvpAwards,
  onClose,
}: ScorecardModalProps) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const previewDataUrl = useMemo(() => {
    try {
      const canvas = generateScorecardCanvas({ roomCode, players, mvpAwards });
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }, [roomCode, players, mvpAwards]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadScorecard({ roomCode, players, mvpAwards });
    } finally {
      setTimeout(() => setDownloading(false), 500);
    }
  };

  const handleCopy = async () => {
    const success = await copyScorecardImage({ roomCode, players, mvpAwards });
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } else {
      // Fallback: copy shareable text summary
      const ranked = [...players].sort((a, b) => b.score - a.score);
      const top3 = ranked
        .slice(0, 3)
        .map((p, i) => `${i + 1}. ${p.name} (${p.score} pts)`)
        .join("\n");
      const summaryText = `🎨 Skribbl Match Results (Room ${roomCode || "Game"}):\n${top3}\nPlay at: ${window.location.origin}`;
      await copyToClipboard(summaryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      data-testid="scorecard-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scorecard-title"
    >
      <div
        className="modal-content scorecard-modal-content"
        onClick={(e) => e.stopPropagation()}
        data-testid="scorecard-modal"
      >
        <div className="modal-header">
          <h2 id="scorecard-title">📸 Match Scorecard</h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
            data-testid="scorecard-modal-close"
          >
            ✕
          </button>
        </div>

        <div className="scorecard-modal-body">
          {previewDataUrl ? (
            <div className="scorecard-preview-wrap">
              <img
                src={previewDataUrl}
                alt="Match Scorecard"
                className="scorecard-preview-img"
                data-testid="scorecard-preview-img"
              />
            </div>
          ) : (
            <div className="scorecard-preview-placeholder">Generating scorecard...</div>
          )}

          <div className="scorecard-actions">
            <button
              type="button"
              className="scorecard-action-btn copy-btn"
              onClick={handleCopy}
              data-testid="copy-scorecard-btn"
            >
              {copied ? "✓ Copied to Clipboard!" : "📋 Copy Image"}
            </button>
            <button
              type="button"
              className="scorecard-action-btn download-btn"
              onClick={handleDownload}
              disabled={downloading}
              data-testid="download-scorecard-btn"
            >
              💾 Download PNG
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
