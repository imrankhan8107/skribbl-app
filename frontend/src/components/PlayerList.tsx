import type { PlayerInfo } from "../types";
import { getAvatarForPlayer, getStoredAvatarId, getStoredPlayerName } from "../utils/avatars";

interface PlayerListProps {
  players: PlayerInfo[];
  isHost?: boolean;
  localPlayerId?: string | null;
  drawerId?: string | null;
  typingUsers?: Record<string, boolean>;
  onKick?: (playerId: string) => void;
}

/**
 * PlayerList — pure presentational component that renders player names,
 * scores, host badge, connection status, guessed indicators, and optional kick button.
 * Requirements: 12.2, 12.4, 12.8
 */
export default function PlayerList({
  players,
  isHost = false,
  localPlayerId = null,
  drawerId = null,
  typingUsers,
  onKick,
}: PlayerListProps) {
  if (!players || !Array.isArray(players)) {
    return <ul className="player-list" data-testid="player-list" />;
  }
  return (
    <ul className="player-list" data-testid="player-list">
      {players.map((player) => {
        const isLocal =
          (localPlayerId && player.id === localPlayerId) ||
          (!localPlayerId && player.name === getStoredPlayerName());
        const explicitAvatar = player.avatar || (isLocal ? getStoredAvatarId() : undefined);
        const avatar = getAvatarForPlayer(player.name || player.id, explicitAvatar);
        const isDrawing = drawerId ? player.id === drawerId : false;
        const classes = [
          "player-item",
          player.isHost ? "player-host" : "",
          !player.isConnected ? "player-disconnected" : "",
          player.hasGuessed ? "player-guessed" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <li key={player.id} className={classes} data-testid="player-item">
            <span
              className="player-avatar-badge"
              style={{ backgroundColor: avatar.bgColor }}
              title={avatar.label}
              data-testid="player-avatar"
            >
              {avatar.emoji}
            </span>
            <span className="player-name">
              {player.name}
              {player.isHost && <span className="host-badge"> (Host)</span>}
              {isDrawing && (
                <span className="player-drawing-icon" title="Drawing now">
                  ✏️
                </span>
              )}
              {player.isFirstGuesser && (
                <span
                  className="player-first-badge"
                  data-testid="player-first-badge"
                  title="First to guess correctly!"
                >
                  ⚡1st
                </span>
              )}
              {(player.streak ?? 0) >= 2 && (
                <span
                  className="player-streak-badge"
                  data-testid="player-streak-badge"
                  title={`${player.streak} correct guesses in a row!`}
                >
                  🔥{player.streak}
                </span>
              )}
              {typingUsers?.[player.id] && !player.hasGuessed && !isDrawing && (
                <span
                  className="player-typing-indicator"
                  data-testid="player-typing"
                  title="Guessing now..."
                >
                  💬...
                </span>
              )}
            </span>
            <span className="player-status">
              {player.isReady && (
                <span className="ready-badge" data-testid="ready-badge" aria-label="Ready">
                  ✓ Ready
                </span>
              )}
              {!player.isConnected && (
                <span
                  className="disconnected-indicator"
                  data-testid="disconnected-indicator"
                  aria-label="Disconnected"
                >
                  ⚠
                </span>
              )}
              {player.hasGuessed && (
                <span
                  className="guessed-indicator"
                  data-testid="guessed-indicator"
                  aria-label="Guessed correctly"
                >
                  ✓
                </span>
              )}
            </span>
            {isHost && player.id !== localPlayerId && onKick && (
              <button
                className="kick-btn"
                onClick={() => onKick(player.id)}
                aria-label={`Kick ${player.name}`}
              >
                ✕
              </button>
            )}
            <span className="player-score" data-testid="player-score">
              {player.score}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
