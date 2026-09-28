import type { PlayerInfo, MvpAward } from "../types";
import { getAvatarForPlayer } from "./avatars";

export interface ScorecardOptions {
  roomCode?: string | null;
  players: PlayerInfo[];
  mvpAwards?: MvpAward[];
}

/**
 * Draw a rounded rectangle on a canvas context (with fallback if roundRect is not supported)
 */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Truncate text with ellipsis if it exceeds max width
 */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let str = text;
  while (str.length > 0 && ctx.measureText(str + "...").width > maxWidth) {
    str = str.slice(0, -1);
  }
  return str + "...";
}

/**
 * Render the final scorecard image to an offscreen canvas.
 * Dimensions: 1200 x 630 (standard 1.91:1 social card ratio)
 */
export function generateScorecardCanvas(options: ScorecardOptions): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const { roomCode, players, mvpAwards } = options;
  const ranked = [...(players || [])].sort((a, b) => b.score - a.score);

  // 1. Background gradient (deep indigo to dark violet)
  const bgGrad = ctx.createLinearGradient(0, 0, 1200, 630);
  bgGrad.addColorStop(0, "#0f172a");
  bgGrad.addColorStop(0.5, "#1e1b4b");
  bgGrad.addColorStop(1, "#311042");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, 1200, 630);

  // Decorative glow circles
  const radialGlow = ctx.createRadialGradient(600, 260, 50, 600, 260, 450);
  radialGlow.addColorStop(0, "rgba(99, 102, 241, 0.25)");
  radialGlow.addColorStop(0.7, "rgba(168, 85, 247, 0.1)");
  radialGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = radialGlow;
  ctx.fillRect(0, 0, 1200, 630);

  // Outer border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, 16, 16, 1168, 598, 24);
  ctx.stroke();

  // 2. Header
  // Brand title
  ctx.font = "bold 34px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("🎨 SKRIBBL", 48, 64);

  ctx.font = "600 20px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillText("• Match Scorecard", 250, 64);

  // Room code badge
  if (roomCode) {
    const codeText = `ROOM: ${roomCode}`;
    ctx.font = "bold 16px monospace";
    const textWidth = ctx.measureText(codeText).width;
    const badgeW = textWidth + 28;
    const badgeH = 36;
    const badgeX = 1152 - badgeW;
    const badgeY = 46;

    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.stroke();

    ctx.fillStyle = "#fbbf24";
    ctx.textAlign = "center";
    ctx.fillText(codeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
  }

  // 3. Top Podium Cards (1st, 2nd, 3rd)
  const podiumOrder = [
    { rank: 2, player: ranked[1], medal: "🥈", x: 120, y: 170, w: 280, h: 260, color: "#94a3b8" },
    { rank: 1, player: ranked[0], medal: "🥇", x: 440, y: 130, w: 320, h: 300, color: "#fbbf24" },
    { rank: 3, player: ranked[2], medal: "🥉", x: 800, y: 180, w: 280, h: 250, color: "#d97706" },
  ];

  podiumOrder.forEach(({ rank, player, medal, x, y, w, h, color }) => {
    if (!player) return;

    // Card background
    ctx.fillStyle = rank === 1 ? "rgba(251, 191, 36, 0.12)" : "rgba(255, 255, 255, 0.06)";
    drawRoundedRect(ctx, x, y, w, h, 20);
    ctx.fill();

    ctx.strokeStyle = rank === 1 ? "rgba(251, 191, 36, 0.45)" : "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = rank === 1 ? 2.5 : 1.5;
    ctx.stroke();

    // Medal
    ctx.font = rank === 1 ? "42px sans-serif" : "34px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(medal, x + w / 2, y + 42);

    // Avatar Circle
    const avatar = getAvatarForPlayer(player.name || player.id, player.avatar);
    const circleY = y + (rank === 1 ? 115 : 105);
    const radius = rank === 1 ? 34 : 28;

    ctx.fillStyle = avatar.bgColor;
    ctx.beginPath();
    ctx.arc(x + w / 2, circleY, radius, 0, Math.PI * 2);
    ctx.fill();

    // Avatar emoji
    ctx.font = rank === 1 ? "34px sans-serif" : "28px sans-serif";
    ctx.fillText(avatar.emoji, x + w / 2, circleY + 2);

    // Player Name
    ctx.font = "bold 22px sans-serif";
    ctx.fillStyle = "#ffffff";
    const displayName = truncateText(ctx, player.name, w - 36);
    ctx.fillText(displayName, x + w / 2, y + (rank === 1 ? 190 : 172));

    // Player Score
    ctx.font = `bold ${rank === 1 ? 30 : 24}px sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(`${player.score} pts`, x + w / 2, y + (rank === 1 ? 245 : 218));
  });

  // 4. MVP Awards or Lower Ranks Row (y ~ 460 - 560)
  if (mvpAwards && mvpAwards.length > 0) {
    const maxShow = Math.min(mvpAwards.length, 3);
    const chipW = 340;
    const startX = 600 - (maxShow * chipW + (maxShow - 1) * 20) / 2;
    const chipY = 465;
    const chipH = 68;

    mvpAwards.slice(0, maxShow).forEach((mvp, idx) => {
      const cx = startX + idx * (chipW + 20);

      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      drawRoundedRect(ctx, cx, chipY, chipW, chipH, 14);
      ctx.fill();
      ctx.strokeStyle = "rgba(168, 85, 247, 0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Badge name
      ctx.font = "bold 16px sans-serif";
      ctx.fillStyle = "#a855f7";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(mvp.badge, cx + 18, chipY + 14);

      // Player name & detail
      ctx.font = "600 15px sans-serif";
      ctx.fillStyle = "#f8fafc";
      const detailStr = `${mvp.playerName} (${mvp.detail})`;
      ctx.fillText(truncateText(ctx, detailStr, chipW - 36), cx + 18, chipY + 38);
    });
  } else if (ranked.length > 3) {
    // Show 4th, 5th, 6th players
    const others = ranked.slice(3, 6);
    const chipW = 260;
    const startX = 600 - (others.length * chipW + (others.length - 1) * 16) / 2;
    const chipY = 475;
    const chipH = 54;

    others.forEach((p, idx) => {
      const cx = startX + idx * (chipW + 16);
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      drawRoundedRect(ctx, cx, chipY, chipW, chipH, 12);
      ctx.fill();

      ctx.font = "bold 16px sans-serif";
      ctx.fillStyle = "#cbd5e1";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`${idx + 4}. ${truncateText(ctx, p.name, 160)}`, cx + 16, chipY + chipH / 2);

      ctx.textAlign = "right";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`${p.score} pts`, cx + chipW - 16, chipY + chipH / 2);
    });
  }

  // 5. Footer
  ctx.font = "500 14px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("Made with Skribbl App • Challenge your friends anytime!", 600, 595);

  return canvas;
}

/**
 * Generate a PNG Blob from the scorecard canvas
 */
export function generateScorecardBlob(options: ScorecardOptions): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const canvas = generateScorecardCanvas(options);
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}

/**
 * Download the scorecard as a PNG file
 */
export async function downloadScorecard(
  options: ScorecardOptions,
  filename?: string
): Promise<void> {
  const canvas = generateScorecardCanvas(options);
  const dataUrl = canvas.toDataURL("image/png");
  const link = document.createElement("a");
  const roomPart = options.roomCode ? `_${options.roomCode.toLowerCase()}` : "";
  link.download = filename || `skribbl_scorecard${roomPart}.png`;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Copy scorecard image directly to system clipboard (for pasting in Discord / Slack / WhatsApp)
 */
export async function copyScorecardImage(options: ScorecardOptions): Promise<boolean> {
  try {
    const blob = await generateScorecardBlob(options);
    if (!blob) return false;

    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function" &&
      typeof ClipboardItem !== "undefined"
    ) {
      const item = new ClipboardItem({ "image/png": blob });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch (err) {
    console.warn("Failed to copy image blob to clipboard:", err);
  }
  return false;
}
