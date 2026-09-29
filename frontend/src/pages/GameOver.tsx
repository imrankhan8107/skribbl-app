import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import { HeaderBar } from "../components/HeaderBar";
import ScorecardModal from "../components/ScorecardModal";
import { getAvatarForPlayer, getStoredAvatarId, getStoredPlayerName } from "../utils/avatars";
import type { RoundArtwork, DrawingAction } from "../types";

/**
 * Utility: hex color to RGBA array
 */
function hexToRGBA(hex: string): [number, number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b, 255];
}

/**
 * Draw stroke helper for replay canvas
 */
function drawReplayStroke(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  strokeColor: string,
  size: number
) {
  if (points.length === 0) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = size;

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  if (points.length === 1) {
    ctx.lineTo(points[0][0] + 0.1, points[0][1] + 0.1);
  }
  ctx.stroke();
}

function drawReplayHighlighter(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  strokeColor: string,
  size: number
) {
  if (points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = size * 2.5;

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  if (points.length === 1) {
    ctx.lineTo(points[0][0] + 0.1, points[0][1] + 0.1);
  }
  ctx.stroke();
  ctx.restore();
}

function drawReplayLine(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  end: [number, number],
  strokeColor: string,
  size: number
) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  ctx.lineTo(end[0], end[1]);
  ctx.stroke();
  ctx.restore();
}

function drawReplayRect(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  end: [number, number],
  strokeColor: string,
  size: number
) {
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = size;
  ctx.lineJoin = "miter";
  const x = Math.min(start[0], end[0]);
  const y = Math.min(start[1], end[1]);
  const w = Math.abs(end[0] - start[0]);
  const h = Math.abs(end[1] - start[1]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawReplayCircle(
  ctx: CanvasRenderingContext2D,
  start: [number, number],
  end: [number, number],
  strokeColor: string,
  size: number
) {
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = size;
  const rx = Math.abs(end[0] - start[0]) / 2;
  const ry = Math.abs(end[1] - start[1]) / 2;
  const cx = Math.min(start[0], end[0]) + rx;
  const cy = Math.min(start[1], end[1]) + ry;
  ctx.beginPath();
  if (typeof ctx.ellipse === "function") {
    ctx.ellipse(cx, cy, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
  } else {
    ctx.arc(cx, cy, Math.max(rx, ry, 0.1), 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * BFS Flood fill helper for replay canvas
 */
function floodFillReplayCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  fillColor: string
) {
  const width = canvas.width;
  const height = canvas.height;
  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    return;
  }
  const data = imageData.data;
  const fillRGBA = hexToRGBA(fillColor);
  const sx = Math.floor(startX);
  const sy = Math.floor(startY);
  if (sx < 0 || sx >= width || sy < 0 || sy >= height) return;

  const startIdx = (sy * width + sx) * 4;
  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];
  const targetA = data[startIdx + 3];

  if (
    targetR === fillRGBA[0] &&
    targetG === fillRGBA[1] &&
    targetB === fillRGBA[2] &&
    targetA === fillRGBA[3]
  ) {
    return;
  }

  const tolerance = 10;
  const matchesTarget = (idx: number): boolean => {
    return (
      Math.abs(data[idx] - targetR) <= tolerance &&
      Math.abs(data[idx + 1] - targetG) <= tolerance &&
      Math.abs(data[idx + 2] - targetB) <= tolerance &&
      Math.abs(data[idx + 3] - targetA) <= tolerance
    );
  };

  const queue: [number, number][] = [[sx, sy]];
  const visited = new Uint8Array(width * height);
  visited[sy * width + sx] = 1;

  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    const idx = (cy * width + cx) * 4;

    if (!matchesTarget(idx)) continue;
    data[idx] = fillRGBA[0];
    data[idx + 1] = fillRGBA[1];
    data[idx + 2] = fillRGBA[2];
    data[idx + 3] = fillRGBA[3];

    const neighbors: [number, number][] = [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ];

    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = ny * width + nx;
        if (!visited[nIdx]) {
          visited[nIdx] = 1;
          queue.push([nx, ny]);
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Animated Timelapse Replay Player Modal
 */
export function ReplayModal({ artwork, onClose }: { artwork: RoundArtwork; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const actions: DrawingAction[] = artwork.replayActions || [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const indexRef = useRef(currentIndex);
  indexRef.current = currentIndex;

  const redrawCanvas = useCallback(
    (upToIndex: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < upToIndex && i < actions.length; i++) {
        const act = actions[i];
        if (act.type === "stroke") {
          drawReplayStroke(ctx, act.points, act.color, act.size);
        } else if (act.type === "highlighter") {
          drawReplayHighlighter(ctx, act.points, act.color, act.size);
        } else if (act.type === "line") {
          drawReplayLine(ctx, act.start, act.end, act.color, act.size);
        } else if (act.type === "rect") {
          drawReplayRect(ctx, act.start, act.end, act.color, act.size);
        } else if (act.type === "circle") {
          drawReplayCircle(ctx, act.start, act.end, act.color, act.size);
        } else if (act.type === "fill") {
          floodFillReplayCanvas(canvas, ctx, act.x, act.y, act.color);
        }
      }
    },
    [actions]
  );

  // Initialize canvas on mount
  useEffect(() => {
    redrawCanvas(0);
    setCurrentIndex(0);
    setIsPlaying(actions.length > 0);
  }, [actions, redrawCanvas]);

  // Animation playback loop
  useEffect(() => {
    if (!isPlaying || actions.length === 0) return;

    let animId: number;
    let lastTime = performance.now();

    const loop = (now: number) => {
      const interval = 28 / speedRef.current;
      if (now - lastTime >= interval) {
        lastTime = now;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        const curr = indexRef.current;

        if (curr >= actions.length) {
          setIsPlaying(false);
          return;
        }

        const step = Math.min(speedRef.current, actions.length - curr);
        if (canvas && ctx) {
          for (let i = 0; i < step; i++) {
            const act = actions[curr + i];
            if (act.type === "stroke") {
              drawReplayStroke(ctx, act.points, act.color, act.size);
            } else if (act.type === "highlighter") {
              drawReplayHighlighter(ctx, act.points, act.color, act.size);
            } else if (act.type === "line") {
              drawReplayLine(ctx, act.start, act.end, act.color, act.size);
            } else if (act.type === "rect") {
              drawReplayRect(ctx, act.start, act.end, act.color, act.size);
            } else if (act.type === "circle") {
              drawReplayCircle(ctx, act.start, act.end, act.color, act.size);
            } else if (act.type === "fill") {
              floodFillReplayCanvas(canvas, ctx, act.x, act.y, act.color);
            }
          }
        }

        const next = curr + step;
        indexRef.current = next;
        setCurrentIndex(next);

        if (next >= actions.length) {
          setIsPlaying(false);
          return;
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, actions]);

  const handleRestart = () => {
    indexRef.current = 0;
    setCurrentIndex(0);
    redrawCanvas(0);
    setIsPlaying(true);
  };

  const handleSeek = (newIndex: number) => {
    const clamped = Math.max(0, Math.min(newIndex, actions.length));
    indexRef.current = clamped;
    setCurrentIndex(clamped);
    redrawCanvas(clamped);
  };

  return (
    <div
      className="gallery-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      data-testid="replay-modal"
    >
      <div
        className="gallery-modal-content replay-modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gallery-modal-header">
          <div>
            <h3 className="gallery-modal-word">🎬 Replay: {artwork.word}</h3>
            <span className="gallery-modal-sub">
              {artwork.drawerAvatar} Drawn by {artwork.drawerName} • Round {artwork.round}
              {artwork.theme ? ` • ${artwork.theme}` : ""}
            </span>
          </div>
          <button
            type="button"
            className="gallery-modal-close"
            onClick={onClose}
            aria-label="Close"
            data-testid="replay-modal-close"
          >
            ✕
          </button>
        </div>

        <div className="gallery-modal-body" style={{ flexDirection: "column" }}>
          <div className="replay-canvas-wrapper">
            <canvas
              ref={canvasRef}
              width={800}
              height={600}
              className="replay-canvas"
              data-testid="replay-canvas"
            />
          </div>
        </div>

        <div className="replay-controls-panel">
          <div className="replay-scrubber-row">
            <input
              type="range"
              min={0}
              max={actions.length}
              value={currentIndex}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="replay-scrubber"
              aria-label="Timeline scrubber"
              data-testid="replay-scrubber"
              disabled={actions.length === 0}
            />
            <span className="replay-counter" data-testid="replay-counter">
              {currentIndex} / {actions.length}
            </span>
          </div>

          <div className="replay-buttons-row">
            <div className="replay-main-buttons">
              <button
                type="button"
                className="replay-ctrl-btn primary"
                onClick={() => {
                  if (currentIndex >= actions.length) {
                    handleRestart();
                  } else {
                    setIsPlaying(!isPlaying);
                  }
                }}
                data-testid="replay-play-pause-btn"
                disabled={actions.length === 0}
              >
                {currentIndex >= actions.length
                  ? "🔄 Replay Again"
                  : isPlaying
                    ? "⏸️ Pause"
                    : "▶️ Play"}
              </button>
              <button
                type="button"
                className="replay-ctrl-btn"
                onClick={handleRestart}
                data-testid="replay-restart-btn"
                disabled={actions.length === 0}
              >
                ⏮️ Restart
              </button>
            </div>

            <div className="replay-speed-group" data-testid="replay-speed-group">
              <button
                type="button"
                className={`replay-speed-btn ${speed === 1 ? "active" : ""}`}
                onClick={() => setSpeed(1)}
                data-testid="replay-speed-1x"
              >
                1x
              </button>
              <button
                type="button"
                className={`replay-speed-btn ${speed === 2 ? "active" : ""}`}
                onClick={() => setSpeed(2)}
                data-testid="replay-speed-2x"
              >
                2x
              </button>
              <button
                type="button"
                className={`replay-speed-btn ${speed === 4 ? "active" : ""}`}
                onClick={() => setSpeed(4)}
                data-testid="replay-speed-4x"
              >
                4x
              </button>
            </div>

            <button
              type="button"
              className="gallery-download-btn"
              onClick={() => downloadArtwork(artwork)}
              title="Download PNG"
            >
              💾 Download
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const [replayArtwork, setReplayArtwork] = useState<RoundArtwork | null>(null);
  const [viewMode, setViewMode] = useState<"game" | "session">("game");
  const [showScorecardModal, setShowScorecardModal] = useState(false);

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

  const hasSessionStats = Boolean(
    gameState.sessionStats &&
    gameState.sessionStats.length > 0 &&
    gameState.sessionStats.some((s) => s.sessionWins > 0 || s.sessionGames > 1)
  );

  const hostJoinRequests =
    gameState.isHost && gameState.pendingJoinRequests && gameState.pendingJoinRequests.length > 0
      ? gameState.pendingJoinRequests
      : [];

  const hostApprovalBanner =
    hostJoinRequests.length > 0 ? (
      <div className="host-join-approval-container" data-testid="host-join-approval-container">
        {hostJoinRequests.map((req) => {
          const avatarInfo = getAvatarForPlayer(req.playerName, req.avatar);
          return (
            <div
              key={req.requestId}
              className="host-join-approval-card"
              data-testid={`join-request-${req.requestId}`}
            >
              <div className="host-join-info">
                <span className="host-join-avatar">{avatarInfo?.emoji || "👋"}</span>
                <div className="host-join-text">
                  <span className="host-join-title">
                    <strong>{req.playerName}</strong> wants to join the room!
                  </span>
                  <span className="host-join-subtitle">
                    Admit them into the lobby for the next game:
                  </span>
                </div>
              </div>
              <div className="host-join-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm join-approve-player-btn"
                  data-testid={`approve-player-${req.requestId}`}
                  onClick={() =>
                    send("respond_join_request", {
                      request_id: req.requestId,
                      action: "accept_player",
                    })
                  }
                >
                  🎮 Accept as Player
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm join-approve-spectator-btn"
                  data-testid={`approve-spectator-${req.requestId}`}
                  onClick={() =>
                    send("respond_join_request", {
                      request_id: req.requestId,
                      action: "accept_spectator",
                    })
                  }
                >
                  👁️ Accept as Spectator
                </button>
                <button
                  type="button"
                  className="btn btn-danger btn-sm join-decline-btn"
                  data-testid={`decline-request-${req.requestId}`}
                  onClick={() =>
                    send("respond_join_request", {
                      request_id: req.requestId,
                      action: "decline",
                    })
                  }
                >
                  ✕ Decline
                </button>
              </div>
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <>
      <HeaderBar roomCode={gameState.roomCode} phase={gameState.phase} />
      <div className="game-over-page">
        <ConfettiCanvas />
        <h1>Game Over</h1>
        {hostApprovalBanner}

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

            {/* Leaderboard View Mode Toggle (if session stats exist) */}
            {hasSessionStats && (
              <div className="leaderboard-view-toggle" data-testid="leaderboard-view-toggle">
                <button
                  type="button"
                  className={`view-toggle-btn ${viewMode === "game" ? "active" : ""}`}
                  onClick={() => setViewMode("game")}
                  data-testid="toggle-view-game"
                >
                  🎮 This Game
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn ${viewMode === "session" ? "active" : ""}`}
                  onClick={() => setViewMode("session")}
                  data-testid="toggle-view-session"
                >
                  🏆 Session Standings
                </button>
              </div>
            )}

            {/* Full Leaderboard */}
            {viewMode === "game" ? (
              <ol data-testid="leaderboard" className="leaderboard">
                {rankedPlayers.map((player, index) => {
                  const isLocal =
                    (gameState.localPlayerId && player.id === gameState.localPlayerId) ||
                    player.name === getStoredPlayerName();
                  const explicitAvatar =
                    player.avatar || (isLocal ? getStoredAvatarId() : undefined);
                  const avatar = getAvatarForPlayer(player.name || player.id, explicitAvatar);
                  return (
                    <li
                      key={player.id}
                      className={`leaderboard-entry leaderboard-rank-${index + 1}`}
                    >
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
            ) : (
              <ol data-testid="session-leaderboard" className="leaderboard session-leaderboard">
                {gameState.sessionStats?.map((stat, index) => {
                  const isLocal =
                    (gameState.localPlayerId && stat.id === gameState.localPlayerId) ||
                    stat.name === getStoredPlayerName();
                  const explicitAvatar =
                    gameState.players.find((p) => p.id === stat.id)?.avatar ||
                    (isLocal ? getStoredAvatarId() : undefined);
                  const avatar = getAvatarForPlayer(stat.name || stat.id, explicitAvatar);
                  return (
                    <li key={stat.id} className={`leaderboard-entry leaderboard-rank-${index + 1}`}>
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
                      <span className="leaderboard-name">{stat.name}</span>
                      <span className="leaderboard-session-wins" title="Games Won">
                        🏆 {stat.sessionWins} {stat.sessionWins === 1 ? "win" : "wins"}
                      </span>
                      <span className="leaderboard-score">{stat.sessionScore} pts</span>
                    </li>
                  );
                })}
              </ol>
            )}

            {/* Game MVPs & Highlights Section */}
            {gameState.mvpAwards && gameState.mvpAwards.length > 0 && (
              <div className="mvp-awards-section" data-testid="mvp-awards-section">
                <div className="mvp-section-header">
                  <h2>🎖️ Match Highlights & MVPs</h2>
                </div>
                <div className="mvp-awards-grid">
                  {gameState.mvpAwards.map((mvp, i) => {
                    const p = gameState.players.find((pl) => pl.id === mvp.playerId);
                    const isLocal = gameState.localPlayerId === mvp.playerId;
                    const explicitAvatar = p?.avatar || (isLocal ? getStoredAvatarId() : undefined);
                    const avatar = getAvatarForPlayer(
                      mvp.playerName || mvp.playerId,
                      explicitAvatar
                    );
                    return (
                      <div key={i} className="mvp-card" data-testid={`mvp-card-${i}`}>
                        <div className="mvp-badge-tag">{mvp.badge}</div>
                        <div className="mvp-player-row">
                          <span
                            className="player-avatar-badge"
                            style={{ backgroundColor: avatar.bgColor }}
                            title={avatar.label}
                          >
                            {avatar.emoji}
                          </span>
                          <span className="mvp-player-name">{mvp.playerName}</span>
                        </div>
                        <div className="mvp-detail">{mvp.detail}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
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
                    <div className="gallery-card-actions">
                      <button
                        type="button"
                        className="gallery-replay-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReplayArtwork(art);
                        }}
                        title="Watch animated drawing replay"
                        data-testid={`replay-artwork-${idx}`}
                      >
                        ▶️ Replay
                      </button>
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
                  className="gallery-replay-btn modal-replay"
                  onClick={() => {
                    const art = selectedArtwork;
                    setSelectedArtwork(null);
                    setReplayArtwork(art);
                  }}
                  data-testid="lightbox-replay-btn"
                >
                  ▶️ Watch Replay
                </button>
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

        {/* Animated Drawing Replay Modal */}
        {replayArtwork && (
          <ReplayModal artwork={replayArtwork} onClose={() => setReplayArtwork(null)} />
        )}

        {/* Scorecard Share Modal */}
        {showScorecardModal && (
          <ScorecardModal
            roomCode={gameState.roomCode}
            players={gameState.players}
            mvpAwards={gameState.mvpAwards}
            onClose={() => setShowScorecardModal(false)}
          />
        )}

        <div className="game-over-actions">
          <button
            type="button"
            className="share-scorecard-button"
            onClick={() => setShowScorecardModal(true)}
            data-testid="open-scorecard-btn"
          >
            📸 Share Scorecard
          </button>
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
