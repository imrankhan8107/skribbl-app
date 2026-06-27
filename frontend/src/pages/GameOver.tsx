import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";

/**
 * GameOver page — displays the final ranked leaderboard and a Rematch button.
 * Reads `players` from `gameState` and sorts by score descending.
 * The Rematch button is only enabled for the host.
 */
export default function GameOver() {
  const { gameState, send } = useWebSocket();
  const navigate = useNavigate();

  // Navigate back to lobby when rematch transitions state to 'lobby'
  useEffect(() => {
    if (gameState.phase === "lobby" && gameState.roomCode) {
      navigate(`/lobby/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  // Sort players by score descending
  const rankedPlayers = [...(gameState.players || [])].sort((a, b) => b.score - a.score);

  return (
    <div className="game-over-page">
      <h1>Game Over</h1>

      {rankedPlayers.length > 0 ? (
        <ol data-testid="leaderboard" className="leaderboard">
          {rankedPlayers.map((player, index) => (
            <li key={player.id} className="leaderboard-entry">
              <span className="leaderboard-rank">{index + 1}</span>
              <span className="leaderboard-name">{player.name}</span>
              <span className="leaderboard-score">{player.score}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p>No scores available</p>
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
            sessionStorage.removeItem('skribbl_session');
            window.location.href = "/";
          }}
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}
