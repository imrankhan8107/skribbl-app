import { useState, useMemo } from "react";
import { generateQRMatrix } from "../utils/qr";
import { copyToClipboard } from "../utils/clipboard";

export interface QRCodeModalProps {
  roomCode: string;
  onClose: () => void;
}

export default function QRCodeModal({ roomCode, onClose }: QRCodeModalProps) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const inviteUrl = `${window.location.origin}/?room=${roomCode}`;

  const matrix = useMemo(() => {
    try {
      return generateQRMatrix(inviteUrl);
    } catch {
      return null;
    }
  }, [inviteUrl]);

  const handleCopyLink = async () => {
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleCopyCode = async () => {
    const ok = await copyToClipboard(roomCode);
    if (ok) {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join my Skribbl game!",
          text: `Join my Skribbl game! Room Code: ${roomCode}`,
          url: inviteUrl,
        });
      } catch (err: unknown) {
        if ((err as Error)?.name !== "AbortError") {
          handleCopyLink();
        }
      }
    } else {
      handleCopyLink();
    }
  };

  const quietZone = 4;
  const matrixSize = matrix?.length ?? 25;
  const fullSize = matrixSize + quietZone * 2;

  return (
    <div
      className="gallery-modal-backdrop qr-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      data-testid="qr-modal"
    >
      <div className="gallery-modal-content qr-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="gallery-modal-header">
          <div>
            <h3 className="gallery-modal-word">📱 Scan to Join Game</h3>
            <span className="gallery-modal-sub">
              Point a camera or phone at the QR code to join this room instantly!
            </span>
          </div>
          <button
            type="button"
            className="gallery-modal-close"
            onClick={onClose}
            aria-label="Close"
            data-testid="qr-modal-close"
          >
            ✕
          </button>
        </div>

        <div className="qr-modal-body" data-testid="qr-modal-body">
          {matrix ? (
            <div className="qr-svg-wrapper" data-testid="qr-svg-wrapper">
              <svg
                viewBox={`0 0 ${fullSize} ${fullSize}`}
                className="qr-code-svg"
                role="img"
                aria-label={`QR Code for room ${roomCode}`}
                data-testid="qr-svg"
              >
                <rect width={fullSize} height={fullSize} fill="#ffffff" rx={1.5} />
                {matrix.map((row, r) =>
                  row.map((isDark, c) =>
                    isDark ? (
                      <rect
                        key={`${r}-${c}`}
                        x={c + quietZone}
                        y={r + quietZone}
                        width={1}
                        height={1}
                        fill="#0f172a"
                      />
                    ) : null
                  )
                )}
              </svg>
            </div>
          ) : (
            <div className="qr-fallback-msg">Could not generate QR code.</div>
          )}

          <div className="qr-code-details">
            <div className="qr-room-code-tag" data-testid="qr-room-code">
              ROOM CODE: <strong>{roomCode}</strong>
            </div>
            <div className="qr-invite-link-preview" title={inviteUrl}>
              {inviteUrl}
            </div>
          </div>
        </div>

        <div className="qr-modal-footer">
          <button
            type="button"
            className={`qr-action-btn ${copiedLink ? "copied" : ""}`}
            onClick={handleCopyLink}
            data-testid="qr-copy-link-btn"
          >
            {copiedLink ? "✓ Invite Link Copied!" : "📋 Copy Invite Link"}
          </button>

          <button
            type="button"
            className={`qr-action-btn secondary ${copiedCode ? "copied" : ""}`}
            onClick={handleCopyCode}
            data-testid="qr-copy-code-btn"
          >
            {copiedCode ? "✓ Code Copied!" : "🔢 Copy Code"}
          </button>

          {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
            <button
              type="button"
              className="qr-action-btn share"
              onClick={handleNativeShare}
              data-testid="qr-native-share-btn"
            >
              📤 Native Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
