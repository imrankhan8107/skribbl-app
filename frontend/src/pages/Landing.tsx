import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import { HeaderBar } from "../components/HeaderBar";
import { AvatarPicker } from "../components/AvatarPicker";
import {
  getStoredAvatarId,
  storeAvatarId,
  getStoredPlayerName,
  storePlayerName,
} from "../utils/avatars";

export default function Landing() {
  const [searchParams] = useSearchParams();
  const roomParam = searchParams.get("room") || "";

  const [playerName, setPlayerName] = useState(getStoredPlayerName);
  const [roomCode, setRoomCode] = useState(() => (roomParam ? roomParam.toUpperCase() : ""));
  const [selectedAvatarId, setSelectedAvatarId] = useState(getStoredAvatarId);
  const { gameState, send } = useWebSocket();
  const navigate = useNavigate();

  // Keep roomCode in sync if URL query param changes
  useEffect(() => {
    const r = searchParams.get("room");
    if (r) {
      setRoomCode(r.toUpperCase());
    }
  }, [searchParams]);

  // Navigate to lobby when phase transitions to 'lobby'
  useEffect(() => {
    if (gameState.phase === "lobby" && gameState.roomCode) {
      navigate(`/lobby/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  const handlePlayerNameChange = (name: string) => {
    setPlayerName(name);
    storePlayerName(name);
  };

  const handleAvatarChange = (avatarId: string) => {
    setSelectedAvatarId(avatarId);
    storeAvatarId(avatarId);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    storePlayerName(playerName);
    storeAvatarId(selectedAvatarId);
    send("create_room", { name: playerName, avatar: selectedAvatarId });
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    storePlayerName(playerName);
    storeAvatarId(selectedAvatarId);
    send("join_room", { name: playerName, room_code: roomCode, avatar: selectedAvatarId });
  };

  return (
    <>
      <HeaderBar phase="idle" />
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
              onChange={(e) => handlePlayerNameChange(e.target.value)}
              placeholder="Enter your name"
              maxLength={20}
              required
            />
          </div>

          <AvatarPicker selectedAvatarId={selectedAvatarId} onSelectAvatar={handleAvatarChange} />

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
            <button
              type="button"
              onClick={handleJoin}
              disabled={!playerName.trim() || !roomCode.trim()}
            >
              Join Room
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
