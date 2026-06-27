import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";

export default function Landing() {
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const { gameState, send } = useWebSocket();
  const navigate = useNavigate();

  // Navigate to lobby when phase transitions to 'lobby'
  useEffect(() => {
    if (gameState.phase === "lobby" && gameState.roomCode) {
      navigate(`/lobby/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    send("create_room", { name: playerName });
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    send("join_room", { name: playerName, room_code: roomCode });
  };

  return (
    <div className="landing-page">
      <h1>Skribbl</h1>

      {gameState.errorMessage && (
        <div className="error-message" role="alert">
          {gameState.errorMessage}
        </div>
      )}

      <form>
        <div>
          <label htmlFor="player-name">Player Name</label>
          <input
            id="player-name"
            type="text"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="Enter your name"
            maxLength={20}
            required
          />
        </div>

        <div>
          <label htmlFor="room-code">Room Code</label>
          <input
            id="room-code"
            type="text"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            placeholder="Enter room code to join"
            maxLength={6}
          />
        </div>

        <div className="landing-actions">
          <button type="button" onClick={handleCreate} disabled={!playerName.trim()}>
            Create Room
          </button>
          <button type="button" onClick={handleJoin} disabled={!playerName.trim() || !roomCode.trim()}>
            Join Room
          </button>
        </div>
      </form>
    </div>
  );
}
