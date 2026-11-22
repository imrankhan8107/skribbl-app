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
  const [joinAsSpectator, setJoinAsSpectator] = useState(false);
  const [roomPassword, setRoomPassword] = useState("");
  const { gameState, send, dispatch } = useWebSocket();
  const navigate = useNavigate();

  // Keep roomCode in sync if URL query param changes
  useEffect(() => {
    const r = searchParams.get("room");
    if (r) {
      setRoomCode(r.toUpperCase());
    }
  }, [searchParams]);

  // Navigate to appropriate screen when joined
  useEffect(() => {
    if (gameState.roomCode) {
      if (gameState.phase === "lobby") {
        navigate(`/lobby/${gameState.roomCode}`);
      } else if (gameState.phase === "playing" || gameState.phase === "word_selection") {
        navigate(`/game/${gameState.roomCode}`);
      } else if (gameState.phase === "game_over") {
        navigate(`/gameover/${gameState.roomCode}`);
      }
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
    const password = roomPassword.trim() || undefined;
    send("create_room", {
      name: playerName,
      avatar: selectedAvatarId,
      ...(password ? { password } : {}),
    });
  };

  const handleJoin = (e?: React.FormEvent, forceSpectator = false) => {
    if (e) e.preventDefault();
    storePlayerName(playerName);
    storeAvatarId(selectedAvatarId);
    const password = roomPassword.trim() || undefined;
    send("join_room", {
      name: playerName,
      room_code: roomCode,
      avatar: selectedAvatarId,
      as_spectator: forceSpectator || joinAsSpectator,
      ...(password ? { password } : {}),
    });
  };

  const isRoomInProgress =
    Boolean(gameState.errorMessage) &&
    gameState.errorMessage!.toLowerCase().includes("not accepting");

  return (
    <>
      <HeaderBar phase="idle" />
      <main className="landing-page" id="main-content">
        <header className="landing-hero-header">
          <span className="seo-hero-badge">🎨 Real-Time Multiplayer Drawing Game</span>
          <h1>Skribbl</h1>
          <p className="seo-hero-subtitle">
            The free online multiplayer sketching &amp; guessing game. Draw with friends, guess
            words in real-time, and climb the podium!
          </p>
        </header>

        {gameState.joinRequestPending && (
          <div className="join-approval-modal-backdrop" data-testid="join-approval-modal">
            <div className="join-approval-modal-card">
              <div className="join-approval-spinner">⏳</div>
              <h2>Waiting for Host Approval</h2>
              <p>
                The match in room <strong>{roomCode}</strong> is in progress. We've asked the host
                to let you in!
              </p>
              <p className="join-approval-hint">
                The host can admit you as a player (starting with 0 score this round) or as a
                spectator.
              </p>
              <div className="join-approval-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="cancel-join-request-btn"
                  onClick={() => {
                    send("cancel_join_request", {
                      request_id: gameState.pendingJoinRequestId,
                    });
                    dispatch({ type: "CANCEL_JOIN_REQUEST" });
                  }}
                >
                  Cancel Request
                </button>
              </div>
            </div>
          </div>
        )}

        {gameState.errorMessage && (
          <div
            className="error-message"
            role="alert"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div>
              {gameState.errorMessage}
              {isRoomInProgress && (
                <div style={{ marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="join-spectator-action-btn"
                    onClick={() => handleJoin(undefined, true)}
                  >
                    👀 Join as Spectator Instead
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="error-dismiss-btn"
              onClick={() => dispatch({ type: "CLEAR_ERROR" })}
              aria-label="Dismiss error"
              style={{
                background: "transparent",
                border: "none",
                fontSize: "1.1rem",
                cursor: "pointer",
                padding: "2px 6px",
                color: "inherit",
                opacity: 0.75,
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Main Game Setup Card */}
        <div className="landing-card-wrapper">
          <form className="landing-game-form">
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

            <div>
              <label htmlFor="room-password">
                {roomCode.trim() ? "Room Password (if private)" : "Room Password (optional)"}
              </label>
              <input
                id="room-password"
                type="password"
                value={roomPassword}
                onChange={(e) => setRoomPassword(e.target.value)}
                placeholder={
                  roomCode.trim()
                    ? "Enter password to join"
                    : "Set password to protect room (optional)"
                }
                maxLength={32}
                autoComplete={roomCode.trim() ? "current-password" : "new-password"}
                data-testid="room-password-input"
              />
            </div>

            <div className="spectator-toggle-wrap">
              <label className="spectator-toggle-label">
                <input
                  type="checkbox"
                  checked={joinAsSpectator}
                  onChange={(e) => setJoinAsSpectator(e.target.checked)}
                  data-testid="spectator-checkbox"
                />
                <span>👀 Join as Spectator (watch only)</span>
              </label>
            </div>

            <div className="landing-actions">
              <button type="button" onClick={handleCreate} disabled={!playerName.trim()}>
                Create Room
              </button>
              <button
                type="button"
                onClick={(e) => handleJoin(e)}
                disabled={!playerName.trim() || !roomCode.trim()}
              >
                Join Room
              </button>
            </div>
          </form>
        </div>

        {/* SEO Content Container for Search Engines & Players */}
        <div className="seo-content-container">
          {/* Key Game Features Section */}
          <section className="seo-section" aria-label="Game Features">
            <h2 className="seo-section-title">Why Players Love Skribbl</h2>
            <div className="seo-features-grid">
              <article className="seo-feature-card">
                <div className="seo-feature-icon" aria-hidden="true">
                  ⚡
                </div>
                <h3>100% Free &amp; Instant</h3>
                <p>
                  No downloads, accounts, or subscriptions. Open your browser on any phone, tablet,
                  or desktop and start sketching in seconds.
                </p>
              </article>

              <article className="seo-feature-card">
                <div className="seo-feature-icon" aria-hidden="true">
                  🎨
                </div>
                <h3>Smooth 60FPS Live Canvas</h3>
                <p>
                  High-performance binary WebSocket drawing engine with customizable brush sizes,
                  vibrant color palettes, and shape snapping tools.
                </p>
              </article>

              <article className="seo-feature-card">
                <div className="seo-feature-icon" aria-hidden="true">
                  🔒
                </div>
                <h3>Private Rooms &amp; Spectating</h3>
                <p>
                  Host private matches with custom passwords. Invite friends with one-click links or
                  QR codes, or join as a spectator to enjoy the show.
                </p>
              </article>

              <article className="seo-feature-card">
                <div className="seo-feature-icon" aria-hidden="true">
                  🏆
                </div>
                <h3>Real-Time Chat &amp; Scoring</h3>
                <p>
                  Race against the clock! Fast guesses score bonus points. Enjoy live player
                  scoreboards, floating emoji reactions, and podium celebrations.
                </p>
              </article>
            </div>
          </section>

          {/* How to Play Section */}
          <section className="seo-section" aria-label="How to Play Guide">
            <h2 className="seo-section-title">How to Play Skribbl in 3 Simple Steps</h2>
            <div className="seo-steps-grid">
              <div className="seo-step-card">
                <div className="seo-step-badge">Step 1</div>
                <h3>Create or Join a Room</h3>
                <p>
                  Enter a nickname, pick an avatar, and create a custom room or enter your friend's
                  6-letter room code.
                </p>
              </div>

              <div className="seo-step-card">
                <div className="seo-step-badge">Step 2</div>
                <h3>Draw Your Word</h3>
                <p>
                  When it's your turn to draw, choose 1 of 3 secret words. Sketch your clue before
                  the timer runs out—no letters or numbers allowed!
                </p>
              </div>

              <div className="seo-step-card">
                <div className="seo-step-badge">Step 3</div>
                <h3>Guess &amp; Win Points</h3>
                <p>
                  When another player draws, type your guesses in the chat. The faster you figure
                  out the word, the higher your score on the leaderboard!
                </p>
              </div>
            </div>
          </section>

          {/* Frequently Asked Questions (FAQ) Section */}
          <section className="seo-section" aria-label="Frequently Asked Questions">
            <h2 className="seo-section-title">Frequently Asked Questions (FAQ)</h2>
            <div className="seo-faq-accordion">
              <details className="seo-faq-item">
                <summary className="seo-faq-question">
                  <span>What is Skribbl and how does it work?</span>
                  <span className="seo-faq-arrow" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="seo-faq-answer">
                  <p>
                    Skribbl is a real-time multiplayer drawing and guessing browser game inspired by
                    classic Pictionary. Players take turns drawing a chosen secret word while
                    everyone else attempts to guess it in the live chat box. Points are awarded
                    based on speed and accuracy.
                  </p>
                </div>
              </details>

              <details className="seo-faq-item">
                <summary className="seo-faq-question">
                  <span>Is Skribbl free to play?</span>
                  <span className="seo-faq-arrow" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="seo-faq-answer">
                  <p>
                    Yes! Skribbl is completely free to play without any hidden paywalls, app
                    installations, or mandatory registration. You can play directly in modern
                    browsers like Google Chrome, Safari, Firefox, and Microsoft Edge.
                  </p>
                </div>
              </details>

              <details className="seo-faq-item">
                <summary className="seo-faq-question">
                  <span>Can I play Skribbl on mobile phones and tablets?</span>
                  <span className="seo-faq-arrow" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="seo-faq-answer">
                  <p>
                    Absolutely. The game is fully responsive and supports touch gestures for stylus
                    and finger drawing on iPhones, Android smartphones, iPads, and touch-enabled
                    laptops.
                  </p>
                </div>
              </details>

              <details className="seo-faq-item">
                <summary className="seo-faq-question">
                  <span>How can I invite friends to a private game?</span>
                  <span className="seo-faq-arrow" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="seo-faq-answer">
                  <p>
                    Simply click <strong>Create Room</strong>, copy your unique 6-character room
                    code or the one-click invite link, and share it with friends via WhatsApp,
                    Discord, or messages. You can also scan the in-lobby QR code with your mobile
                    camera.
                  </p>
                </div>
              </details>

              <details className="seo-faq-item">
                <summary className="seo-faq-question">
                  <span>How does Spectator Mode work?</span>
                  <span className="seo-faq-arrow" aria-hidden="true">
                    ▾
                  </span>
                </summary>
                <div className="seo-faq-answer">
                  <p>
                    If a match is already underway or you simply want to watch your friends play,
                    check the <strong>Join as Spectator</strong> option. Spectators can watch the
                    drawing canvas and chat reactions in real-time without competing for points.
                  </p>
                </div>
              </details>
            </div>
          </section>

          {/* SEO Footer */}
          <footer className="landing-seo-footer">
            <p className="landing-footer-brand">
              <strong>Skribbl</strong> — The Ultimate Free Online Drawing &amp; Guessing Game.
            </p>
            <p className="landing-footer-keywords">
              Keywords: Pictionary online, free multiplayer drawing game, guess the drawing, skribbl
              with friends, browser doodle game, party games online.
            </p>
            <p className="landing-footer-copyright">
              &copy; {new Date().getFullYear()} Skribbl. All rights reserved. Play with friends
              worldwide.
            </p>
          </footer>
        </div>
      </main>
    </>
  );
}
