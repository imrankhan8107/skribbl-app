import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import PlayerList from "../components/PlayerList";
import Chat from "../components/Chat";

export default function Lobby() {
  const { gameState, send } = useWebSocket();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  // Fallback config in case state is not yet populated
  const config = gameState.config ?? { numRounds: 3, turnDuration: 80, maxPlayers: 8 };

  // Navigate to game when phase transitions to 'playing' or 'word_selection'
  useEffect(() => {
    if ((gameState.phase === "playing" || gameState.phase === "word_selection") && gameState.roomCode) {
      navigate(`/game/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  // Navigate to landing when kicked
  useEffect(() => {
    if (gameState.phase === "idle" && gameState.errorMessage) {
      navigate("/");
    }
  }, [gameState.phase, gameState.errorMessage, navigate]);

  // Show nothing while reconnecting
  if (gameState.phase === "idle") {
    if (gameState.errorMessage) {
      return (
        <div className="lobby-page">
          <h1>Session Expired</h1>
          <p>{gameState.errorMessage}</p>
          <button onClick={() => window.location.href = "/"}>Back to Home</button>
        </div>
      );
    }
    return null;
  }

  const handleCopyCode = () => {
    if (gameState.roomCode) {
      navigator.clipboard.writeText(gameState.roomCode);
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
    sessionStorage.removeItem('skribbl_session');
    window.location.href = "/";
  };

  const handleKickPlayer = (targetPlayerId: string) => {
    send("kick_player", { target_player_id: targetPlayerId });
  };

  const handleToggleReady = () => {
    send("toggle_ready");
  };

  const localPlayer = gameState.players.find(p => p.id === gameState.localPlayerId);
  const isReady = localPlayer?.isReady ?? false;
  const readyCount = gameState.players.filter(p => p.isReady).length;
  const totalCount = gameState.players.length;
  const canStart = gameState.isHost && gameState.players.length >= 2;

  return (
    <div className="lobby-page">
      <div className="lobby-header">
        <h1>Lobby</h1>
        <button
          className="room-code-btn"
          onClick={handleCopyCode}
          data-testid="room-code"
          title="Click to copy room code"
        >
          {gameState.roomCode} 📋
        </button>
      </div>

      {/* Snackbar for copy feedback */}
      {copied && (
        <div className="snackbar" data-testid="snackbar">
          Room code copied to clipboard!
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
          />

          <div className="lobby-settings">
            <h2>Game Settings</h2>
            <fieldset disabled={!gameState.isHost}>
              <div>
                <label htmlFor="rounds">Rounds</label>
                <select id="rounds" value={config.numRounds} onChange={handleRoundsChange}>
                  {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="duration">Turn Duration (seconds)</label>
                <select id="duration" value={config.turnDuration} onChange={handleDurationChange}>
                  {[30, 45, 60, 80, 100, 120, 150, 180].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="max-players">Max Players</label>
                <select id="max-players" value={config.maxPlayers} onChange={handleMaxPlayersChange}>
                  {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            </fieldset>
          </div>

          <div className="lobby-actions">
            <button
              className={`ready-btn ${isReady ? "ready-btn-active" : ""}`}
              onClick={handleToggleReady}
              data-testid="ready-btn"
            >
              {isReady ? "Ready ✓" : "Not Ready"}
            </button>
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
  );
}
