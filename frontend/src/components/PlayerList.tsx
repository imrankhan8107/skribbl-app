import type { PlayerInfo } from "../types";
import { getAvatarForPlayer, getStoredAvatarId, getStoredPlayerName } from "../utils/avatars";

interface PlayerListProps {
  players: PlayerInfo[];
  isHost?: boolean;
  localPlayerId?: string | null;
  drawerId?: string | null;
  typingUsers?: Record<string, boolean>;
  mutedPlayerIds?: Set<string>;
  onToggleMute?: (playerId: string) => void;
  onVoteKick?: (playerId: string) => void;
  canVoteKick?: boolean;
  onKick?: (playerId: string) => void;
  onTransferHost?: (playerId: string) => void;
  onEditProfile?: () => void;
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
  mutedPlayerIds,
  onToggleMute,
  onVoteKick,
  canVoteKick = true,
  onKick,
  onTransferHost,
  onEditProfile,
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
          player.isSpectator ? "player-spectator" : "",
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
              {player.isSpectator && (
                <span className="spectator-badge" data-testid="spectator-badge" title="Spectating">
                  {" "}
                  👀 Spectating
                </span>
              )}
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
            {isLocal && onEditProfile && (
              <button
                type="button"
                className="player-edit-profile-btn"
                onClick={onEditProfile}
                title="Edit your avatar & name"
                data-testid="player-edit-profile-btn"
                aria-label="Edit your profile"
              >
                ✏️
              </button>
            )}
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
            {isHost && player.id !== localPlayerId && !player.isSpectator && onTransferHost && (
              <button
                type="button"
                className="transfer-host-btn"
                onClick={() => onTransferHost(player.id)}
                title={`Make ${player.name} host`}
                aria-label={`Make ${player.name} host`}
                data-testid={`transfer-host-${player.id}`}
              >
                👑
              </button>
            )}
            {isHost && player.id !== localPlayerId && onKick && (
              <button
                className="kick-btn"
                onClick={() => onKick(player.id)}
                aria-label={`Kick ${player.name}`}
              >
                ✕
              </button>
            )}
            {!isLocal && onToggleMute && (
              <button
                type="button"
                className="player-mute-btn"
                onClick={() => onToggleMute(player.id)}
                title={
                  mutedPlayerIds?.has(player.id) ? `Unmute ${player.name}` : `Mute ${player.name}`
                }
                aria-label={
                  mutedPlayerIds?.has(player.id) ? `Unmute ${player.name}` : `Mute ${player.name}`
                }
                data-testid={`mute-player-${player.id}`}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 4px",
                  fontSize: "13px",
                  opacity: mutedPlayerIds?.has(player.id) ? 1 : 0.6,
                }}
              >
                {mutedPlayerIds?.has(player.id) ? "🔇" : "🔊"}
              </button>
            )}
            {!isLocal && player.isConnected && canVoteKick && onVoteKick && (
              <button
                type="button"
                className="player-vote-kick-btn"
                onClick={() => onVoteKick(player.id)}
                title={`Vote to kick ${player.name}`}
                aria-label={`Vote to kick ${player.name}`}
                data-testid={`vote-kick-${player.id}`}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 4px",
                  fontSize: "13px",
                  opacity: 0.8,
                }}
              >
                🗳️
              </button>
            )}
            <span className="player-score" data-testid="player-score">
              {player.isSpectator ? "👀" : player.score}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
