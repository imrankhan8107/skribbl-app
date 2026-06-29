import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import type { Action } from "../types";
import Canvas from "../components/Canvas";
import Chat from "../components/Chat";
import PlayerList from "../components/PlayerList";
import TimerBar from "../components/TimerBar";

/**
 * Game page — renders the active game view with canvas, chat, player list,
 * hint display, timer, and round indicators.
 * Requirements: 12.2, 12.3, 12.4, 12.5, 12.8
 */
export default function Game() {
  const navigate = useNavigate();
  const { gameState, send, dispatch } = useWebSocket();
  const [countdown, setCountdown] = useState(0);
  const [showRoundTransition, setShowRoundTransition] = useState(false);
  const prevRoundRef = useRef(0);
  const shownForRoundRef = useRef(0);

  // Track when the round number changes
  useEffect(() => {
    if (gameState.currentRound > 0 && gameState.currentRound !== prevRoundRef.current) {
      prevRoundRef.current = gameState.currentRound;
      // If the canvas is visible (playing phase), show immediately
      if (gameState.phase === "playing") {
        shownForRoundRef.current = gameState.currentRound;
        setShowRoundTransition(true);
      }
      // Otherwise (word_selection for drawer), we'll trigger when phase becomes "playing"
    }
  }, [gameState.currentRound, gameState.phase]);

  // For the drawer: show animation when entering "playing" phase if not yet shown for this round
  useEffect(() => {
    if (
      gameState.phase === "playing" &&
      gameState.currentRound > 0 &&
      shownForRoundRef.current !== gameState.currentRound
    ) {
      shownForRoundRef.current = gameState.currentRound;
      setShowRoundTransition(true);
    }
  }, [gameState.phase, gameState.currentRound]);

  const handleTransitionComplete = useCallback(() => {
    setShowRoundTransition(false);
  }, []);

  // Drive the countdown timer: dispatch TICK every second while playing
  useEffect(() => {
    if (gameState.phase !== "playing") return;
    const id = setInterval(() => {
      dispatch({ type: "TICK" });
    }, 1000);
    return () => clearInterval(id);
  }, [gameState.phase, dispatch]);

  // Navigate to game over when phase transitions
  useEffect(() => {
    if (gameState.phase === "game_over" && gameState.roomCode) {
      navigate(`/gameover/${gameState.roomCode}`);
    }
  }, [gameState.phase, gameState.roomCode, navigate]);

  // Reconnection countdown timer
  useEffect(() => {
    if (gameState.waitingForReconnect) {
      setCountdown(gameState.reconnectCountdown);
      const id = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(id);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(id);
    } else {
      setCountdown(0);
    }
  }, [gameState.waitingForReconnect, gameState.reconnectCountdown]);

  // Word selection phase — show choices to drawer, waiting message to guessers
  const drawerName =
    gameState.players.find((p) => p.id === gameState.drawerId)?.name ?? "The drawer";

  // Show loading state while reconnecting
  if (gameState.phase === "idle" || gameState.phase === "lobby") {
    return (
      <div className="game-page" data-testid="game-page">
        <h2>Reconnecting...</h2>
        <p>Please wait while we restore your session.</p>
      </div>
    );
  }

  // Reconnection banner component
  const reconnectBanner = gameState.waitingForReconnect ? (
    <div
      className="reconnect-banner"
      data-testid="reconnect-banner"
      style={{
        background: "#fff3cd",
        border: "1px solid #ffc107",
        borderRadius: "8px",
        padding: "12px 16px",
        margin: "8px 0",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}
    >
      <span>Player disconnected — waiting for reconnection ({countdown}s remaining)...</span>
      {gameState.isHost && (
        <button
          className="end-game-now-btn"
          data-testid="end-game-now-btn"
          onClick={() => send("end_game_now", {})}
          style={{
            background: "#dc3545",
            color: "white",
            border: "none",
            borderRadius: "4px",
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          End Game Now
        </button>
      )}
    </div>
  ) : null;

  if (gameState.phase === "word_selection") {
    return (
      <div className="game-page" data-testid="game-page">
        {reconnectBanner}
        <div className="game-header" data-testid="game-header">
          <span className="round-indicator" data-testid="round-indicator">
            Round {gameState.currentRound || 1} /{" "}
            {gameState.totalRounds || gameState.config?.numRounds || 3}
          </span>
        </div>
        {gameState.isDrawer && gameState.wordChoices.length > 0 ? (
          <div className="word-selection" data-testid="word-selection">
            <h2>Choose a word to draw:</h2>
            <div className="word-choices">
              {gameState.wordChoices.map((word) => (
                <button
                  key={word}
                  className="word-choice-btn"
                  onClick={() => {
                    send("select_word", { word });
                    dispatch({ type: "WORD_SELECTED", payload: { word } } as unknown as Action);
                  }}
                >
                  {word}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="word-selection-waiting" data-testid="word-selection-waiting">
            <h2>{drawerName} is choosing a word...</h2>
          </div>
        )}
        <div className="game-content" data-testid="game-content">
          <div className="game-left">
            <PlayerList players={gameState.players} />
          </div>
        </div>
      </div>
    );
  }

  // Playing phase — full game UI
  return (
    <div className="game-page" data-testid="game-page">
      {reconnectBanner}

      {/* Round and turn indicators */}
      <div className="game-header" data-testid="game-header">
        <span className="round-indicator" data-testid="round-indicator">
          Round {gameState.currentRound} / {gameState.totalRounds}
        </span>
        <TimerBar seconds={gameState.timerSeconds} total={gameState.config?.turnDuration ?? 80} />
      </div>

      {/* Hint display — drawer sees the actual word */}
      <div className="hint-display" data-testid="hint-display">
        {gameState.isDrawer && gameState.currentWord ? (
          <span className="hint-char hint-word" data-testid="hint-word">
            {gameState.currentWord}
          </span>
        ) : (
          gameState.hint.map((char, idx) => (
            <span
              key={idx}
              className={`hint-char${char === "_" ? " hint-hidden" : ""}`}
              data-testid="hint-char"
            >
              {char === "_" ? "_" : char}
            </span>
          ))
        )}
      </div>

      {/* Main game area: canvas + chat */}
      <div className="game-content" data-testid="game-content">
        <div className="game-left">
          {/* Player list with live scores */}
          <PlayerList players={gameState.players} />
        </div>
        <div className="game-center">
          <Canvas
            isDrawer={gameState.isDrawer}
            showRoundTransition={showRoundTransition}
            roundInfo={{ round: gameState.currentRound, totalRounds: gameState.totalRounds }}
            onTransitionComplete={handleTransitionComplete}
          />
        </div>
        <div className="game-right">
          <Chat />
        </div>
      </div>
    </div>
  );
}
