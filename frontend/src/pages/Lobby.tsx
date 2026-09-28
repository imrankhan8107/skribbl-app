import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import PlayerList from "../components/PlayerList";
import Chat from "../components/Chat";
import { HeaderBar } from "../components/HeaderBar";
import QRCodeModal from "../components/QRCodeModal";
import ProfileModal from "../components/ProfileModal";
import { copyToClipboard } from "../utils/clipboard";
import { getStoredAvatarId, getStoredPlayerName } from "../utils/avatars";

const PRESET_PACKS = [
  { name: "🧙‍♂️ Fantasy", words: ["Dragon", "Wizard", "Castle", "Potion", "Unicorn", "Knight"] },
  {
    name: "🎮 Gaming",
    words: ["Minecraft", "Pikachu", "Mario", "Fortnite", "PlayStation", "Zelda"],
  },
  {
    name: "🎬 Cinema",
    words: ["Lightsaber", "Titanic", "Avatar", "Batman", "Spider-Man", "Inception"],
  },
  { name: "🍕 Foodie", words: ["Sushi", "Tacos", "Croissant", "Pancakes", "Bubble Tea", "Ramen"] },
];

export default function Lobby() {
  const { gameState, send } = useWebSocket();
  const { roomCode: routeRoomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [snackbarText, setSnackbarText] = useState("Room code copied to clipboard!");
  const [showQRModal, setShowQRModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // Fallback config in case state is not yet populated
  const config = gameState.config ?? { numRounds: 3, turnDuration: 80, maxPlayers: 8 };

  const [customWordsText, setCustomWordsText] = useState(
    config.customWords ? config.customWords.join(", ") : ""
  );
  const isCustomWordsDirtyRef = useRef(false);

  useEffect(() => {
    if (!isCustomWordsDirtyRef.current && config.customWords) {
      setCustomWordsText(config.customWords.join(", "));
    }
  }, [config.customWords]);

  const applyCustomWords = (text: string) => {
    const words = text
      .split(/[\n,]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0 && w.length <= 40);

    const seen = new Set<string>();
    const uniqueWords: string[] = [];
    for (const w of words) {
      if (!seen.has(w.toLowerCase())) {
        seen.add(w.toLowerCase());
        uniqueWords.push(w);
      }
    }
    isCustomWordsDirtyRef.current = false;
    send("update_settings", { custom_words: uniqueWords });
  };

  const handleCustomWordsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    isCustomWordsDirtyRef.current = true;
    setCustomWordsText(e.target.value);
  };

  const handleCustomWordsBlur = () => {
    applyCustomWords(customWordsText);
  };

  const handleAddPreset = (presetWords: string[]) => {
    const existing = customWordsText
      .split(/[\n,]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const combined = [...existing, ...presetWords];
    const newText = combined.join(", ");
    setCustomWordsText(newText);
    applyCustomWords(newText);
  };

  const handleClearCustomWords = () => {
    setCustomWordsText("");
    applyCustomWords("");
  };

  // Navigate to game when phase transitions to 'playing' or 'word_selection'
  useEffect(() => {
    if (
      (gameState.phase === "playing" || gameState.phase === "word_selection") &&
      gameState.roomCode
    ) {
      navigate(`/game/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  // Navigate to landing when kicked
  useEffect(() => {
    if (gameState.phase === "idle" && gameState.errorMessage) {
      navigate("/");
    }
  }, [gameState.phase, gameState.errorMessage, navigate]);

  // When a player lands on /lobby/:roomCode directly without an active session,
  // redirect to landing homepage with roomCode prefilled
  useEffect(() => {
    if (gameState.phase === "idle" && !gameState.errorMessage && routeRoomCode) {
      const sessionStr =
        typeof sessionStorage !== "undefined" ? sessionStorage.getItem("skribbl_session") : null;
      let hasMatchingSession = false;
      if (sessionStr) {
        try {
          const parsed = JSON.parse(sessionStr);
          if (parsed.roomCode && parsed.roomCode.toUpperCase() === routeRoomCode.toUpperCase()) {
            hasMatchingSession = true;
          }
        } catch {
          hasMatchingSession = false;
        }
      }
      if (!hasMatchingSession) {
        navigate(`/?room=${routeRoomCode.toUpperCase()}`, { replace: true });
      }
    }
  }, [gameState.phase, gameState.errorMessage, routeRoomCode, navigate]);

  // Show nothing while reconnecting
  if (gameState.phase === "idle") {
    if (gameState.errorMessage) {
      return (
        <div className="lobby-page">
          <h1>Session Expired</h1>
          <p>{gameState.errorMessage}</p>
          <button onClick={() => (window.location.href = "/")}>Back to Home</button>
        </div>
      );
    }
    return null;
  }

  const handleCopyCode = async () => {
    if (gameState.roomCode) {
      const ok = await copyToClipboard(gameState.roomCode);
      if (ok) {
        setSnackbarText("Room code copied to clipboard!");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleShare = async () => {
    if (!gameState.roomCode) return;
    const inviteUrl = `${window.location.origin}/?room=${gameState.roomCode}`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Join my Skribbl game!",
          text: `Join my Skribbl game! Room Code: ${gameState.roomCode}`,
          url: inviteUrl,
        });
        return;
      } catch (err: unknown) {
        if ((err as Error)?.name === "AbortError") return;
      }
    }
    const ok = await copyToClipboard(inviteUrl);
    if (ok) {
      setSnackbarText("Invite link copied to clipboard!");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRoundsChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    send("update_settings", { num_rounds: Number(e.target.value) });
  };

  const handleDurationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    send("update_settings", { turn_duration: Number(e.target.value) });
  };

  const handleMaxPlayersChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    send("update_settings", { max_players: Number(e.target.value) });
  };

  const handleStartGame = () => {
    send("start_game");
  };

  const handleLeaveRoom = () => {
    send("leave_room");
    sessionStorage.removeItem("skribbl_session");
    window.location.href = "/";
  };

  const handleKickPlayer = (targetPlayerId: string) => {
    send("kick_player", { target_player_id: targetPlayerId });
  };

  const handleTransferHost = (targetPlayerId: string) => {
    const target = gameState.players.find((p) => p.id === targetPlayerId);
    const confirmed = window.confirm(
      `Are you sure you want to transfer room host to ${target?.name || "this player"}?`
    );
    if (confirmed) {
      send("transfer_host", { target_player_id: targetPlayerId });
    }
  };

  const handleToggleReady = () => {
    send("toggle_ready");
  };

  const handleSaveProfile = (newName: string, newAvatarId: string) => {
    localStorage.setItem("skribbl_player_name", newName);
    localStorage.setItem("skribbl_player_avatar", newAvatarId);

    const sessionStr = sessionStorage.getItem("skribbl_session");
    if (sessionStr) {
      try {
        const session = JSON.parse(sessionStr);
        sessionStorage.setItem(
          "skribbl_session",
          JSON.stringify({ ...session, playerName: newName })
        );
      } catch {
        /* ignore */
      }
    }

    send("update_profile", { name: newName, avatar: newAvatarId });
    setSnackbarText("Profile updated!");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const localPlayer = gameState.players.find((p) => p.id === gameState.localPlayerId);
  const isReady = localPlayer?.isReady ?? false;
  const activePlayers = gameState.players.filter((p) => !p.isSpectator);
  const readyCount = activePlayers.filter((p) => p.isReady).length;
  const totalCount = activePlayers.length;
  const canStart = gameState.isHost && activePlayers.length >= 2;

  return (
    <>
      <HeaderBar phase={gameState.phase} />
      <div className="lobby-page">
        <div className="lobby-header">
          <h1>Lobby</h1>
          <div className="lobby-header-actions">
            <button
              className={`room-code-btn ${copied && snackbarText.includes("Room code") ? "copied" : ""}`}
              onClick={handleCopyCode}
              data-testid="room-code"
              title="Click to copy room code"
            >
              {gameState.roomCode}{" "}
              {copied && snackbarText.includes("Room code") ? "✓ Copied!" : "📋"}
            </button>
            <button
              type="button"
              className="lobby-qr-btn"
              onClick={() => setShowQRModal(true)}
              data-testid="lobby-qr-btn"
              title="Show QR code for mobile scanning"
            >
              📱 QR Code
            </button>
            <button
              type="button"
              className="lobby-share-btn"
              onClick={handleShare}
              data-testid="lobby-share-btn"
              title="Share invite link"
            >
              📤 Share
            </button>
          </div>
        </div>

        {/* Snackbar for copy feedback */}
        {copied && (
          <div className="snackbar" data-testid="snackbar">
            {snackbarText}
          </div>
        )}

        <div className="lobby-content">
          {/* Left side: Players + Settings */}
          <div className="lobby-left">
            <PlayerList
              players={gameState.players}
              isHost={gameState.isHost}
              localPlayerId={gameState.localPlayerId}
              onKick={handleKickPlayer}
              onTransferHost={handleTransferHost}
              onEditProfile={() => setShowProfileModal(true)}
            />

            <div className="lobby-settings">
              <h2>Game Settings</h2>
              <fieldset disabled={!gameState.isHost}>
                <div>
                  <label htmlFor="rounds">Rounds</label>
                  <select id="rounds" value={config.numRounds} onChange={handleRoundsChange}>
                    {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="duration">Turn Duration (seconds)</label>
                  <select id="duration" value={config.turnDuration} onChange={handleDurationChange}>
                    {[30, 45, 60, 80, 100, 120, 150, 180].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="max-players">Max Players</label>
                  <select
                    id="max-players"
                    value={config.maxPlayers}
                    onChange={handleMaxPlayersChange}
                  >
                    {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Custom Words Section */}
                <div className="custom-words-section">
                  <div className="custom-words-header">
                    <label htmlFor="custom-words">Custom Words (Pack Creator)</label>
                    {config.customWords && config.customWords.length > 0 && (
                      <span className="custom-words-count-badge" data-testid="custom-words-count">
                        ✨ {config.customWords.length} words
                      </span>
                    )}
                  </div>
                  {gameState.isHost && (
                    <div className="custom-words-presets">
                      <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>
                        Presets:
                      </span>
                      {PRESET_PACKS.map((preset) => (
                        <button
                          key={preset.name}
                          type="button"
                          className="preset-chip"
                          data-testid={`preset-pack-${preset.name.toLowerCase().replace(/[^a-z]/g, "")}`}
                          onClick={() => handleAddPreset(preset.words)}
                        >
                          + {preset.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    id="custom-words"
                    className="custom-words-textarea"
                    data-testid="custom-words-textarea"
                    rows={2}
                    placeholder="Type words separated by commas or newlines (e.g. Hogwarts, Pikachu, Lightsaber)"
                    value={customWordsText}
                    onChange={handleCustomWordsChange}
                    onBlur={handleCustomWordsBlur}
                    disabled={!gameState.isHost}
                  />
                  <div className="custom-words-footer">
                    <span className="custom-words-hint">
                      {gameState.isHost
                        ? "Injected as ✨ Custom Words pack in word selection"
                        : `${config.customWords?.length || 0} custom words configured by host`}
                    </span>
                    {gameState.isHost && (
                      <div style={{ display: "flex", gap: "4px" }}>
                        {customWordsText && (
                          <button
                            type="button"
                            className="preset-chip"
                            onClick={handleClearCustomWords}
                            style={{ color: "var(--color-danger)" }}
                          >
                            Clear
                          </button>
                        )}
                        <button
                          type="button"
                          className="custom-words-save-btn"
                          data-testid="save-custom-words-btn"
                          onClick={() => applyCustomWords(customWordsText)}
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </fieldset>
            </div>

            {gameState.isSpectator && (
              <div
                className="spectator-banner"
                data-testid="spectator-banner"
                style={{ margin: "1rem 0" }}
              >
                <span className="spectator-banner-icon">👀</span>
                <span>You joined as a Spectator. You will watch once the game begins.</span>
              </div>
            )}

            <div className="lobby-actions">
              {!gameState.isSpectator && (
                <button
                  className={`ready-btn ${isReady ? "ready-btn-active" : ""}`}
                  onClick={handleToggleReady}
                  data-testid="ready-btn"
                >
                  {isReady ? "Ready ✓" : "Not Ready"}
                </button>
              )}
              <button className="start-game-btn" onClick={handleStartGame} disabled={!canStart}>
                Start Game ({readyCount}/{totalCount} Ready)
              </button>
              <button className="leave-room-btn" onClick={handleLeaveRoom}>
                Leave Room
              </button>
            </div>
          </div>

          {/* Right side: Chat */}
          <div className="lobby-right">
            <Chat />
          </div>
        </div>
      </div>
      {showQRModal && gameState.roomCode && (
        <QRCodeModal roomCode={gameState.roomCode} onClose={() => setShowQRModal(false)} />
      )}
      {showProfileModal && (
        <ProfileModal
          currentName={localPlayer?.name || getStoredPlayerName()}
          currentAvatarId={localPlayer?.avatar || getStoredAvatarId()}
          onSave={handleSaveProfile}
          onClose={() => setShowProfileModal(false)}
        />
      )}
    </>
  );
}
