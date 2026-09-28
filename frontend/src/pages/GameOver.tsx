import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import { HeaderBar } from "../components/HeaderBar";
import { getAvatarForPlayer, getStoredAvatarId, getStoredPlayerName } from "../utils/avatars";
import type { RoundArtwork } from "../types";

/**
 * Canvas-based confetti/party popper animation.
 * Bursts confetti from the bottom-center once on mount, particles arc outward with gravity.
 */
function ConfettiCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationId: number;

    function resize() {
      canvas!.width = canvas!.offsetWidth;
      canvas!.height = canvas!.offsetHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    const colors = [
      "#ff6b6b",
      "#feca57",
      "#48dbfb",
      "#ff9ff3",
      "#54a0ff",
      "#5f27cd",
      "#01a3a4",
      "#f368e0",
      "#ff9f43",
      "#00d2d3",
      "#ee5253",
      "#10ac84",
    ];

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      color: string;
      size: number;
      rotation: number;
      rotationSpeed: number;
      shape: "rect" | "circle" | "strip";
      gravity: number;
      friction: number;
      opacity: number;
      fadeRate: number;
    }

    const particles: Particle[] = [];

    // Burst from two points (left and right) to simulate two poppers
    function burst(
      originX: number,
      originY: number,
      count: number,
      angleMin: number,
      angleMax: number
    ) {
      for (let i = 0; i < count; i++) {
        const angle = (angleMin + Math.random() * (angleMax - angleMin)) * (Math.PI / 180);
        const speed = 12 + Math.random() * 18;
        const shapes: Particle["shape"][] = ["rect", "circle", "strip"];
        particles.push({
          x: originX,
          y: originY,
          vx: Math.cos(angle) * speed,
          vy: -Math.sin(angle) * speed, // negative = upward
          color: colors[Math.floor(Math.random() * colors.length)],
          size: 4 + Math.random() * 6,
          rotation: Math.random() * 360,
          rotationSpeed: (Math.random() - 0.5) * 15,
          shape: shapes[Math.floor(Math.random() * shapes.length)],
          gravity: 0.25 + Math.random() * 0.1,
          friction: 0.98,
          opacity: 1,
          fadeRate: 0.003 + Math.random() * 0.004,
        });
      }
    }

    // Fire two bursts — one from bottom-left, one from bottom-right
    const w = canvas.width;
    const h = canvas.height;
    burst(w * 0.15, h * 0.85, 80, 30, 80); // left popper, angles upward-right
    burst(w * 0.85, h * 0.85, 80, 100, 150); // right popper, angles upward-left

    // Re-fire smaller bursts periodically to keep it lively
    const interval = setInterval(() => {
      const cw = canvas!.width;
      const ch = canvas!.height;
      burst(cw * 0.15, ch * 0.85, 40, 30, 80);
      setTimeout(() => burst(cw * 0.85, ch * 0.85, 40, 100, 150), 200);
    }, 4000);

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);

      for (const p of particles) {
        if (p.opacity <= 0) continue;

        p.vy += p.gravity;
        p.vx *= p.friction;
        p.vy *= p.friction;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        p.opacity -= p.fadeRate;

        ctx!.save();
        ctx!.globalAlpha = Math.max(0, p.opacity);
        ctx!.translate(p.x, p.y);
        ctx!.rotate((p.rotation * Math.PI) / 180);

        ctx!.fillStyle = p.color;

        if (p.shape === "rect") {
          ctx!.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else if (p.shape === "circle") {
          ctx!.beginPath();
          ctx!.arc(0, 0, p.size / 3, 0, Math.PI * 2);
          ctx!.fill();
        } else {
          // strip — long thin rectangle
          ctx!.fillRect(-p.size, -p.size / 6, p.size * 2, p.size / 3);
        }

        ctx!.restore();
      }

      animationId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(animationId);
      clearInterval(interval);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 2,
      }}
    />
  );
}

function downloadArtwork(art: RoundArtwork) {
  const link = document.createElement("a");
  const safeWord = (art.word || "drawing").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const safeDrawer = (art.drawerName || "player").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  link.download = `skribbl_${safeWord}_by_${safeDrawer}.png`;
  link.href = art.imageDataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * GameOver page — displays the final ranked leaderboard with winner highlight.
 * The Rematch button is only enabled for the host.
 */
export default function GameOver() {
  const { gameState, send } = useWebSocket();
  const navigate = useNavigate();
  const [selectedArtwork, setSelectedArtwork] = useState<RoundArtwork | null>(null);

  // Navigate back to lobby when rematch transitions state to 'lobby'
  useEffect(() => {
    if (gameState.phase === "lobby" && gameState.roomCode) {
      navigate(`/lobby/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  // Sort players by score descending
  const rankedPlayers = [...(gameState.players || [])].sort((a, b) => b.score - a.score);
  const winner = rankedPlayers[0];

  const winnerIsLocal =
    (gameState.localPlayerId && winner?.id === gameState.localPlayerId) ||
    winner?.name === getStoredPlayerName();
  const winnerExplicitAvatar = winner?.avatar || (winnerIsLocal ? getStoredAvatarId() : undefined);
  const winnerAvatar = winner
    ? getAvatarForPlayer(winner.name || winner.id, winnerExplicitAvatar)
    : null;

  return (
    <>
      <HeaderBar roomCode={gameState.roomCode} phase={gameState.phase} />
      <div className="game-over-page">
        <ConfettiCanvas />
        <h1>Game Over</h1>

        {winner ? (
          <>
            {/* Winner Card — decorative highlight with avatar */}
            <div className="winner-card" data-testid="winner-card">
              <div className="winner-trophy">🏆</div>
              {winnerAvatar && (
                <div
                  className="winner-avatar-badge"
                  style={{
                    backgroundColor: winnerAvatar.bgColor,
                    fontSize: "2.2rem",
                    width: "56px",
                    height: "56px",
                    borderRadius: "50%",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0.25rem auto 0.5rem",
                    boxShadow: "var(--shadow-sm)",
                  }}
                  title={winnerAvatar.label}
                >
                  {winnerAvatar.emoji}
                </div>
              )}
              <div className="winner-label">Winner</div>
              <div className="winner-name">{winner.name}</div>
              <div className="winner-score">{winner.score} pts</div>
            </div>

            {/* Full Leaderboard */}
            <ol data-testid="leaderboard" className="leaderboard">
              {rankedPlayers.map((player, index) => {
                const isLocal =
                  (gameState.localPlayerId && player.id === gameState.localPlayerId) ||
                  player.name === getStoredPlayerName();
                const explicitAvatar = player.avatar || (isLocal ? getStoredAvatarId() : undefined);
                const avatar = getAvatarForPlayer(player.name || player.id, explicitAvatar);
                return (
                  <li key={player.id} className={`leaderboard-entry leaderboard-rank-${index + 1}`}>
                    <span className="leaderboard-rank">
                      {index === 0 ? "1" : index === 1 ? "2" : index === 2 ? "3" : `${index + 1}`}
                    </span>
                    <span className="leaderboard-medal">
                      {index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : ""}
                    </span>
                    <span
                      className="player-avatar-badge"
                      style={{ backgroundColor: avatar.bgColor, margin: "0 0.4rem" }}
                      title={avatar.label}
                    >
                      {avatar.emoji}
                    </span>
                    <span className="leaderboard-name">{player.name}</span>
                    <span className="leaderboard-score">{player.score} pts</span>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <p>No scores available</p>
        )}

        {/* Masterpiece Gallery */}
        {gameState.artworkGallery && gameState.artworkGallery.length > 0 && (
          <div className="masterpiece-gallery-section" data-testid="masterpiece-gallery">
            <div className="gallery-header">
              <h2>🎨 Masterpiece Gallery</h2>
              <p className="gallery-subtitle">
                Relive every drawing from this game! Click any image to view or download.
              </p>
            </div>
            <div className="gallery-grid">
              {gameState.artworkGallery.map((art, idx) => (
                <div key={idx} className="gallery-card" data-testid={`gallery-card-${idx}`}>
                  <div
                    className="gallery-card-img-wrap"
                    onClick={() => setSelectedArtwork(art)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedArtwork(art);
                    }}
                    title={`View drawing for ${art.word}`}
                  >
                    <img
                      src={art.imageDataUrl}
                      alt={`Drawing of ${art.word}`}
                      className="gallery-thumbnail"
                      loading="lazy"
                    />
                    <div className="gallery-hover-overlay">
                      <span>🔍 Expand</span>
                    </div>
                  </div>
                  <div className="gallery-card-info">
                    <div className="gallery-card-title-row">
                      <span className="gallery-card-word">{art.word}</span>
                      {art.theme && <span className="gallery-card-theme-tag">{art.theme}</span>}
                    </div>
                    <div className="gallery-card-meta">
                      <span className="gallery-drawer-badge">
                        <span className="gallery-drawer-avatar">{art.drawerAvatar || "🎨"}</span>
                        <span className="gallery-drawer-name">{art.drawerName || "Anonymous"}</span>
                      </span>
                      <span className="gallery-round-tag">R{art.round}</span>
                    </div>
                    <button
                      type="button"
                      className="gallery-download-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadArtwork(art);
                      }}
                      title="Download PNG"
                      data-testid={`download-artwork-${idx}`}
                    >
                      💾 Download
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Lightbox Modal */}
        {selectedArtwork && (
          <div
            className="gallery-modal-backdrop"
            onClick={() => setSelectedArtwork(null)}
            role="dialog"
            aria-modal="true"
            data-testid="gallery-modal"
          >
            <div className="gallery-modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="gallery-modal-header">
                <div>
                  <h3 className="gallery-modal-word">{selectedArtwork.word}</h3>
                  <span className="gallery-modal-sub">
                    {selectedArtwork.drawerAvatar} Drawn by {selectedArtwork.drawerName} • Round{" "}
                    {selectedArtwork.round}
                    {selectedArtwork.theme ? ` • ${selectedArtwork.theme}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="gallery-modal-close"
                  onClick={() => setSelectedArtwork(null)}
                  aria-label="Close"
                  data-testid="gallery-modal-close"
                >
                  ✕
                </button>
              </div>
              <div className="gallery-modal-body">
                <img
                  src={selectedArtwork.imageDataUrl}
                  alt={selectedArtwork.word}
                  className="gallery-modal-img"
                />
              </div>
              <div className="gallery-modal-footer">
                <button
                  type="button"
                  className="gallery-download-btn modal-download"
                  onClick={() => downloadArtwork(selectedArtwork)}
                >
                  💾 Download Artwork (PNG)
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="game-over-actions">
          <button
            className="rematch-button"
            onClick={() => send("rematch")}
            disabled={!gameState.isHost}
          >
            Rematch
          </button>
          <button
            className="dashboard-button"
            onClick={() => {
              sessionStorage.removeItem("skribbl_session");
              window.location.href = "/";
            }}
          >
            Back to Home
          </button>
        </div>
      </div>
    </>
  );
}
