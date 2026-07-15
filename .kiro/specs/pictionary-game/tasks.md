# Implementation Plan: Pictionary Game

## Overview

Implement a real-time multiplayer drawing and guessing game using a Python/FastAPI backend with WebSocket communication and a React 18 + Vite frontend. The backend manages all game state in-memory; the frontend is a React SPA served as static files from FastAPI.

## Tasks

- [x] 1. Project scaffolding and core data models
  - Create directory structure: `backend/` and `frontend/` (Vite + React 18 project)
  - Create `backend/models.py` with all dataclasses and enums: `RoomState`, `TurnEndReason`, `Player`, `GameConfig`, `TurnState`, `Room`
  - Create `backend/words.py` with a default word list of at least 200 common nouns
  - Create `backend/main.py` with the FastAPI app, static file mounting, and WebSocket route registration (stub only)
  - Scaffold the Vite + React frontend: `frontend/index.html`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/package.json`
  - Create `frontend/src/types/index.ts` with shared TypeScript interfaces: `PlayerInfo`, `GameConfig`, `GamePhase`, `GameState`, `Action`
  - Create `pytest.ini` with `asyncio_mode = auto`
  - _Requirements: 1.1, 10.1, 11.1_

- [x] 2. Room management
  - [x] 2.1 Implement `RoomManager` in `backend/room_manager.py`
    - Generate unique 6-character alphanumeric uppercase `Room_Code` values
    - `create_room(name, websocket)` → creates `Room`, assigns Host, returns `room_created` payload
    - `join_room(name, room_code, websocket)` → validates state/capacity/name, adds `Player`, returns `room_joined` payload
    - `remove_player(player_id)` → handles host reassignment and room cleanup
    - `broadcast(room_code, message)` → sends JSON to all connected players in a room
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 2.8, 2.9_

  - [x] 2.2 Write property test for room code uniqueness
    - **Property 1: Room code uniqueness**
    - **Validates: Requirements 1.1**
    - Use `@given(st.integers(min_value=1, max_value=500))` to simulate N room creations and assert all codes are distinct

  - [x] 2.3 Write property test for player capacity enforcement
    - **Property 2: Player capacity enforcement**
    - **Validates: Requirements 1.6, 1.7**
    - Use `@given(st.integers(min_value=0, max_value=20))` to attempt joins beyond max capacity and assert rejection

  - [x] 2.4 Write property test for display name validation
    - **Property 3: Display name validation**
    - **Validates: Requirements 1.8, 1.9**
    - Use `@given(st.text())` and assert server accepts iff `1 <= len(name) <= 20`

- [x] 3. Lobby settings and game start
  - [x] 3.1 Implement settings update and game start logic in `RoomManager` / `ws_handler.py`
    - Handle `update_settings` message: validate ranges, reject non-host, broadcast `settings_updated`
    - Handle `start_game` message: reject non-host, reject < 2 players, transition room to `WORD_SELECTION`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 3.2 Write property test for settings bounds enforcement
    - **Property 4: Settings bounds enforcement**
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - Use `@given(st.integers())` for each field and assert accept iff within defined range

  - [x] 3.3 Write property test for host-only permission enforcement
    - **Property 5: Host-only permission enforcement**
    - **Validates: Requirements 2.5, 9.5**
    - Use `@given(st.booleans())` to simulate host vs non-host senders and assert rejection for non-host

- [x] 4. Checkpoint — core room lifecycle
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Word selection and hint generation
  - [x] 5.1 Implement word selection logic in `backend/game_engine.py`
    - Maintain a per-game shuffled word pool; track `used_words`
    - `draw_word_choices(room)` → returns 3 unique words from the pool without repeating session words
    - Reshuffle and reuse pool when exhausted
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 5.2 Implement hint generation in `backend/game_engine.py`
    - `generate_initial_hint(word)` → underscores for non-space chars, spaces preserved
    - `reveal_hint_char(hint, word)` → reveals one random unrevealed non-space character; never reveals the last hidden char
    - _Requirements: 3.3, 4.1, 4.2, 4.3, 4.5_

  - [x] 5.3 Write property test for hint initial state
    - **Property 6: Hint initial state** — **Validates: Requirements 3.3, 4.1**
    - Use `@given(st.text(alphabet=st.characters(blacklist_categories=('Cs',))))` and assert hint length equals word length, spaces preserved, non-spaces are underscores

  - [x] 5.4 Write property test for hint never fully reveals the word
    - **Property 7: Hint never fully reveals the word** — **Validates: Requirements 4.5**
    - Use `@given(word, reveal_count)` and assert at least one underscore remains after any number of reveals < len(non-space chars)

  - [x] 5.5 Write property test for hint character count invariant
    - **Property 8: Hint character count invariant** — **Validates: Requirements 4.1, 4.2, 4.3**
    - Use `@given(word, reveal_sequence)` and assert hint length equals word length at every step

  - [x] 5.6 Write property test for word uniqueness within a session
    - **Property 12: Word uniqueness within a session** — **Validates: Requirements 10.2**
    - Use `@given(st.integers(1, 200))` to simulate N turns and assert no word repeats until pool exhausted

- [x] 6. Scoring logic
  - [x] 6.1 Implement scoring functions in `backend/game_engine.py`
    - `compute_guesser_score(elapsed, duration)` → `round(max(50, 500 - (elapsed / duration) * 450))`
    - `compute_drawer_bonus(guesser_scores)` → `round(mean(guesser_scores))` or 0 if empty
    - _Requirements: 7.1, 7.2, 7.3, 7.5_

  - [x] 6.2 Write property test for correct guess scoring formula
    - **Property 9: Correct guess scoring formula** — **Validates: Requirements 7.1**
    - Use `@given(st.floats(min_value=0, max_value=1, allow_nan=False))` and assert score in [50, 500] and monotonically non-increasing with elapsed ratio

  - [x] 6.3 Write property test for drawer bonus equals average of guesser scores
    - **Property 10: Drawer bonus equals average of guesser scores** — **Validates: Requirements 7.2, 7.3**
    - Use `@given(st.lists(st.integers(50, 500), min_size=1))` and assert bonus equals `round(mean(scores))`

  - [x] 6.4 Write property test for cumulative score monotonicity
    - **Property 11: Cumulative score monotonicity** — **Validates: Requirements 7.5**
    - Use `@given(st.lists(st.integers(0, 500), min_size=1))` to simulate score additions and assert cumulative score never decreases

- [x] 7. Checkpoint — word selection, hints, and scoring
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Turn and round lifecycle
  - [x] 8.1 Implement turn lifecycle in `backend/game_engine.py`
    - `start_turn(room)` → sends `word_choices` to drawer, transitions to `WORD_SELECTION`, starts 15-second auto-select timer
    - `handle_word_selection(room, player_id, word)` → validates drawer, sets `TurnState`, broadcasts `turn_started`, schedules hint tasks at 40% and 70% of duration, starts turn timer
    - `end_turn(room, reason)` → cancels timer tasks, computes scores, broadcasts `turn_ended`, advances drawer index
    - `advance_turn_or_round(room)` → increments round counter when all players have drawn; transitions to `GAME_OVER` after final round
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.2, 4.3, 4.4, 7.4, 10.4, 10.5_

  - [x] 8.2 Write unit tests for turn lifecycle
    - Test word auto-selection after 15 seconds
    - Test hint scheduling at 40% and 70% elapsed
    - Test turn advancement after all players have drawn
    - Test round increment and game-over transition
    - _Requirements: 3.4, 3.5, 3.6, 3.7, 10.5_

- [x] 9. Guess handling and chat
  - [x] 9.1 Implement guess evaluation in `backend/game_engine.py`
    - `handle_guess(room, player_id, text)` → case-insensitive strip comparison; award score; broadcast `guess_correct` or `chat_message`; lock out player from further guesses; end turn if all guessed
    - `handle_chat(room, player_id, text)` → drawer chat broadcast; strip word from message before broadcast
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [x] 9.2 Write property test for guess case-insensitivity
    - **Property 13: Guess case-insensitivity** — **Validates: Requirements 6.2**
    - Use `@given(st.text(), st.text())` and assert server accepts iff `guess.strip().lower() == word.lower()`

  - [x] 9.3 Write property test for correct guesser lockout
    - **Property 14: Correct guesser lockout** — **Validates: Requirements 6.4**
    - Simulate a player guessing correctly then submitting additional guesses; assert subsequent guesses are silently ignored

  - [x] 9.4 Write property test for word not revealed in chat during active turn
    - **Property 15: Word not revealed in chat during active turn** — **Validates: Requirements 6.6**
    - Use `@given(word, guess_text)` and assert broadcast message does not contain word as case-insensitive substring

- [x] 10. Disconnection and reconnection handling
  - [x] 10.1 Implement disconnection logic in `backend/room_manager.py` and `backend/game_engine.py`
    - On guesser disconnect: mark player as disconnected (`is_connected=False`), continue turn, check < 2 connected players condition
    - On drawer disconnect: end turn immediately with 0 points, advance to next turn
    - On host disconnect in lobby: reassign host or close room
    - Retain `Player` record for 120 seconds (2 minutes) with `is_connected=False` and `disconnect_time`; schedule `cleanup_task` (asyncio.Task) to permanently remove player after 120 seconds
    - While disconnected: award 0 points for any turns/rounds that occur; skip player if it would be their turn to draw
    - On reconnect within 120-second window: cancel `cleanup_task`, restore player with original score, set `is_connected=True`, clear `disconnect_time`, broadcast `player_reconnected`
    - On cleanup_task firing (120 seconds elapsed without reconnect): permanently remove player record and all associated data from the room; broadcast updated player list
    - _Requirements: 2.8, 2.9, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 10.2 Write unit tests for disconnection scenarios
    - Test guesser disconnect: player marked disconnected, turn continues
    - Test drawer disconnect: turn ends with 0 points
    - Test < 2 connected players: game ends with `game_ended_insufficient_players`
    - Test disconnected player receives 0 points for missed turns/rounds
    - Test disconnected player is skipped when it would be their turn to draw
    - Test reconnection within 120-second window: score and record restored, cleanup_task cancelled
    - Test reconnection after 120-second window: player record permanently removed
    - Test cleanup_task fires after 120 seconds and removes player data
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

- [x] 11. Heartbeat monitor
  - [x] 11.1 Implement `backend/heartbeat.py`
    - Background `asyncio.Task` per connection: ping every 30 seconds
    - If no pong within 10 seconds, forcibly close connection and trigger disconnect handling
    - _Requirements: 11.4, 11.5_

  - [x] 11.2 Write unit tests for heartbeat timeout
    - Test that a non-responding connection is closed after 10-second pong timeout
    - _Requirements: 11.5_

- [x] 12. WebSocket handler and message dispatch
  - [x] 12.1 Implement `backend/ws_handler.py`
    - Accept connection, assign `player_id` (UUID), await `identify` message
    - Dispatch all client message types to `RoomManager` / `GameEngine` handlers
    - Wrap all handlers in `try/except`; log exceptions; send `error` message to client without mutating room state
    - Start heartbeat task on connect; cancel on disconnect
    - _Requirements: 11.1, 11.2, 11.3, 11.6_

  - [x] 12.2 Write integration tests for WebSocket message dispatch
    - Full flow: create room → join → start game → word selection → stroke → guess → score → game over
    - Test all error codes: `ROOM_NOT_FOUND`, `ROOM_IN_PROGRESS`, `ROOM_FULL`, `INVALID_NAME`, `PERMISSION_DENIED`, `INSUFFICIENT_PLAYERS`, `INVALID_SETTINGS`, `NOT_YOUR_TURN`, `ALREADY_GUESSED`, `GAME_NOT_ACTIVE`
    - _Requirements: 11.1, 11.2, 11.3, 11.6_

- [x] 13. Checkpoint — full backend
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Game over and rematch
  - [x] 14.1 Implement rematch logic in `backend/game_engine.py` and `backend/room_manager.py`
    - Handle `rematch` message: reject non-host; reset all player scores to 0; reset round counter; reset `used_words` and `word_pool`; transition room to `LOBBY`; broadcast lobby state and config reset
    - _Requirements: 9.3, 9.4, 9.5_

  - [x] 14.2 Write unit tests for rematch flow
    - Test score reset, round counter reset, state transition to LOBBY
    - Test non-host rematch rejection
    - _Requirements: 9.3, 9.4, 9.5_

- [x] 15. Frontend — React project setup and shared state
  - [x] 15.1 Implement `frontend/src/context/WebSocketContext.tsx`
    - Define `GameState`, `Action` union type, and `gameReducer` pure function handling all server message types
    - Implement `WebSocketProvider`: owns the `WebSocket` instance via `useRef`, wires `ws.onmessage` to `dispatch`, exposes `{ gameState, send, isConnected }` via context
    - Mount provider in `frontend/src/main.tsx` wrapping `<App />`
    - _Requirements: 11.1, 11.6, 12.2, 12.3, 12.4, 12.5_

  - [x] 15.2 Implement `frontend/src/hooks/useWebSocket.ts`
    - Custom hook that calls `useContext(WebSocketContext)` and returns `{ gameState, send, isConnected }`
    - _Requirements: 11.1, 11.6_

  - [x] 15.3 Implement `frontend/src/App.tsx`
    - Define React Router v6 `<Routes>`: `/` → `Landing`, `/lobby/:roomCode` → `Lobby`, `/game/:roomCode` → `Game`, `/gameover/:roomCode` → `GameOver`
    - _Requirements: 12.1_

  - [x] 15.4 Write reducer unit tests (`gameReducer.test.ts`)
    - Pure function tests: assert each `Action` type produces the correct `GameState` transition
    - Cover: `ROOM_JOINED`, `PLAYER_LIST`, `GAME_STARTED`, `TURN_STARTED`, `HINT_UPDATE`, `TURN_ENDED`, `GAME_OVER`, `TICK`, `RESET`
    - _Requirements: 12.2, 12.3, 12.4, 12.5_

- [x] 16. Frontend — Landing and Lobby pages
  - [x] 16.1 Implement `frontend/src/pages/Landing.tsx`
    - Controlled form with player name and room code inputs (`useState`)
    - On create: calls `send('create_room', { name })`; on join: calls `send('join_room', { name, room_code })`
    - Navigates to `/lobby/:roomCode` when `gameState.phase` transitions to `'lobby'`
    - Displays error messages from `gameState` on `ROOM_NOT_FOUND`, `ROOM_FULL`, `INVALID_NAME`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9, 12.1_

  - [x] 16.2 Implement `frontend/src/pages/Lobby.tsx`
    - Renders `<PlayerList />` with all players; highlights host
    - Displays room code prominently (Requirement 12.1)
    - Host-only settings form (rounds, duration, max players) with `onChange` calling `send('update_settings', ...)`
    - Start Game button calls `send('start_game')`; disabled when player count < 2 or local player is not host
    - Handles `PLAYER_LIST`, `SETTINGS_UPDATED`, `GAME_STARTED` actions via `gameState`
    - Navigates to `/game/:roomCode` when `gameState.phase` becomes `'playing'`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 12.1, 12.2_

  - [x] 16.3 Write component tests for Landing and Lobby
    - `Landing.tsx`: assert form submission calls `send` with correct args; assert error display on bad server response
    - `Lobby.tsx`: assert settings form disabled for non-host; assert Start Game button calls `send('start_game')`
    - _Requirements: 1.1, 2.5, 12.1_

- [x] 17. Frontend — canvas and drawing tools
  - [x] 17.1 Implement `frontend/src/hooks/useCanvas.ts`
    - Accepts `canvasRef: React.RefObject<HTMLCanvasElement>` and `isDrawer: boolean`
    - Attaches pointer event listeners via `useEffect` (mousedown/mousemove/mouseup + touch equivalents); emits `stroke` messages via `send`
    - Implements flood-fill (BFS on pixel data via `getImageData`/`putImageData`); emits `fill` messages
    - Implements eraser (stroke with canvas background color)
    - Implements `clearCanvas()` and `renderRemoteStroke()` / `renderRemoteFill()` for incoming server broadcasts
    - Manages tool, color, and brush-size state via `useState`
    - All pointer handlers are no-ops when `isDrawer` is `false`
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 5.7, 5.8, 5.9, 5.11_

  - [x] 17.2 Implement `frontend/src/components/Canvas.tsx`
    - Renders `<canvas>` element (minimum 800×600 logical pixels) via `useRef` passed to `useCanvas`
    - Renders drawing toolbar: color picker (≥8 colors), brush size selector (small/medium/large), eraser button, fill tool button, clear canvas button
    - Toolbar hidden/disabled when `isDrawer` is `false`
    - Forwards incoming `stroke`, `fill`, `clear_canvas` events from `gameState` to hook's render methods
    - _Requirements: 5.1, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 12.6, 12.9_

  - [x] 17.3 Write component tests for Canvas
    - Assert toolbar is hidden when `isDrawer` is `false`
    - Assert `send('stroke', ...)` is called on pointer drag when `isDrawer` is `true`
    - Assert `send('clear_canvas')` is called on clear button click
    - _Requirements: 5.9, 12.9_

- [x] 18. Frontend — Game page and Chat component
  - [x] 18.1 Implement `frontend/src/pages/Game.tsx`
    - Composes `<Canvas isDrawer={gameState.isDrawer} />` and `<Chat />` side by side
    - Renders hint display (array of chars from `gameState.hint`), updated on `HINT_UPDATE`
    - Renders round/turn indicators from `gameState.currentRound` / `gameState.totalRounds`
    - Renders `<PlayerList />` with live scores; visually distinguishes correctly-guessed players
    - Renders `<TimerBar seconds={gameState.timerSeconds} total={gameState.config.turnDuration} />`
    - Drives timer via `useEffect` + `setInterval` dispatching `TICK` every second while `phase === 'playing'`
    - Navigates to `/gameover/:roomCode` when `gameState.phase` becomes `'game_over'`
    - _Requirements: 12.2, 12.3, 12.4, 12.5, 12.8_

  - [x] 18.2 Implement `frontend/src/components/Chat.tsx`
    - Renders scrollable message feed (`useRef` + `useEffect` for auto-scroll)
    - Controlled input (`useState`); on submit calls `send('guess', { text })` for Guessers or `send('chat', { text })` for Drawer
    - Input disabled when `isDrawer` is `true` or `hasGuessed` is `true`
    - Styles system messages and correct-guess notifications with distinct CSS classes
    - _Requirements: 6.1, 6.3, 6.5, 6.8_

  - [x] 18.3 Implement `frontend/src/components/PlayerList.tsx` and `frontend/src/components/TimerBar.tsx`
    - `PlayerList`: pure presentational component; accepts `players: PlayerInfo[]`; renders name, score, connection/guessed status
    - `TimerBar`: accepts `seconds: number` and `total: number`; renders CSS-animated countdown progress bar
    - _Requirements: 12.2, 12.4_

  - [x] 18.4 Write component tests for Game page and Chat
    - `Game.tsx`: assert hint chars render correctly; assert timer decrements on `TICK`; assert navigation to `/gameover` on `GAME_OVER`
    - `Chat.tsx`: assert input disabled when `isDrawer` is `true`; assert input disabled when `hasGuessed` is `true`; assert correct-guess messages receive distinct styling
    - _Requirements: 6.4, 12.4, 12.5, 12.8_

- [x] 19. Frontend — Game Over page
  - [x] 19.1 Implement `frontend/src/pages/GameOver.tsx`
    - Reads final `players` (sorted by score descending) from `gameState`
    - Renders ranked leaderboard with player names and scores
    - Renders Rematch button; calls `send('rematch')` on click; button disabled when `gameState.isHost` is `false`
    - _Requirements: 9.1, 9.2, 9.3, 12.10_

  - [x] 19.2 Write component tests for GameOver
    - Assert leaderboard renders players sorted by score
    - Assert Rematch button disabled for non-host
    - Assert `send('rematch')` called on host button click
    - _Requirements: 9.1, 9.2, 9.5_

- [x] 20. Responsive layout
  - [x] 20.1 Implement responsive CSS across all pages and components
    - Use CSS media queries or flexbox/grid to ensure correct rendering at 360px, 768px, 1280px, and 1920px viewport widths
    - Verify canvas minimum resolution of 800×600 logical pixels is maintained
    - _Requirements: 12.6, 12.7_

- [x] 21. Additional game features
  - [x] 21.1 Implement emoji reactions
    - Handle `reaction` message in `ws_handler.py`; broadcast `{player_name, emoji}` to all players in room
    - Display reactions as system chat messages in the frontend
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 21.2 Implement kick player and leave room
    - `kick_player(host_player_id, target_player_id)` in `room_manager.py` — validates host, removes target, sends `kicked` message, broadcasts player list
    - `leave_room(player_id)` in `room_manager.py` — removes player voluntarily, handles host reassignment, broadcasts player list
    - _Requirements: 2.12, 2.13_

  - [x] 21.3 Implement ready check system
    - `toggle_ready(player_id)` in `room_manager.py` — toggles player's `is_ready` field, broadcasts updated player list
    - Frontend displays ready status in lobby player list
    - _Requirements: 2.10_

  - [x] 21.4 Implement lobby chat
    - Handle `chat` message in lobby state: broadcast chat_message directly without guess evaluation
    - _Requirements: 2.11_

  - [x] 21.5 Implement round transition animation
    - Create `RoundTransition.tsx` component with slide-in/pause/slide-out animation
    - Display round number overlay between rounds
    - _Requirements: 12.11_

  - [x] 21.6 Implement disconnect countdown with end game now
    - 20-second countdown when < 2 connected players remain (broadcast `waiting_for_reconnect`)
    - Host can send `end_game_now` to immediately end game during countdown
    - Cancelled on reconnection (broadcast `reconnect_resumed`)
    - _Requirements: 8.3, 8.4, 8.5, 8.6_

  - [x] 21.7 Implement auto-reconnect on page refresh
    - Store session info (player name, room code) in `sessionStorage`
    - On WebSocket connect, detect game/lobby route and send `reconnect` message
    - Server restores full game state in `reconnected` response
    - _Requirements: 11.7, 11.8_

- [x] 22. Multi-worker scaling with Redis
  - [x] 22.1 Implement Redis pub/sub adapter (`backend/redis_pubsub.py`)
    - Connect to Redis when `REDIS_URL` environment variable is set
    - Publish room broadcasts to Redis channels for cross-worker relay
    - Subscribe to Redis channels and relay messages to local players
    - Worker ID generation for sticky session routing
    - _Requirements: 14.1, 14.2, 14.4_

  - [x] 22.2 Implement sticky session middleware
    - `StickySessionMiddleware` in `main.py` sets `worker_id` cookie on first response
    - Only active when `REDIS_URL` is configured (multi-worker mode)
    - _Requirements: 14.3_

  - [x] 22.3 Configure nginx load balancer
    - `nginx.conf` with `ip_hash`, WebSocket upgrade support, and long-lived timeouts
    - `docker-compose.yml` for local multi-worker testing with Redis + nginx
    - _Requirements: 14.5, 14.6_

  - [x] 22.4 Write sticky session performance test
    - `scripts/perf_test_sticky.py` — tests multi-worker deployment with cookie-based routing
    - Worker affinity detection and reporting

- [x] 23. Final checkpoint — full integration
  - Ensure all backend and frontend tests pass (213 backend + 62 frontend = 275 total)
  - Run integration tests: full room creation → join → start → turn → guess → score → game over flow
  - Verify disconnection, reconnection, and rematch flows end-to-end
  - Verify multi-worker scaling with Redis pub/sub
  - Ask the user if questions arise.


## Notes

- Each task references specific requirements for traceability
- Property-based tests use the [Hypothesis](https://hypothesis.readthedocs.io/) library; run with `HYPOTHESIS_MAX_EXAMPLES=500` in CI
- Unit and integration tests use `pytest` with `pytest-asyncio`; integration tests use `httpx.AsyncClient` with `ASGITransport`
- Frontend tests use Vitest + React Testing Library (`@testing-library/react`); run with `vitest run` for single-pass CI execution
- The Vite dev server proxies `/ws` to the FastAPI backend; in production, FastAPI serves the built frontend as static files from `/static`
- Checkpoints (tasks 4, 7, 13) ensure incremental validation at key milestones before proceeding
- Multi-worker deployment uses Redis pub/sub for cross-worker message relay (task 22)
- Smart pre-commit hook only checks changed files (frontend and backend independently)
- Total test count: 213 backend + 62 frontend = 275 tests

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "5.1", "5.2", "6.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.1", "5.3", "5.4", "5.5", "5.6", "6.2", "6.3", "6.4"] },
    { "id": 3, "tasks": ["3.2", "3.3", "8.1", "9.1"] },
    { "id": 4, "tasks": ["8.2", "9.2", "9.3", "9.4", "10.1"] },
    { "id": 5, "tasks": ["10.2", "11.1", "14.1"] },
    { "id": 6, "tasks": ["11.2", "12.1", "14.2"] },
    { "id": 7, "tasks": ["12.2", "15.1", "15.2", "15.3"] },
    { "id": 8, "tasks": ["15.4", "16.1", "16.2"] },
    { "id": 9, "tasks": ["16.3", "17.1", "17.2"] },
    { "id": 10, "tasks": ["17.3", "18.1", "18.2", "18.3"] },
    { "id": 11, "tasks": ["18.4", "19.1"] },
    { "id": 12, "tasks": ["19.2", "20.1"] },
    { "id": 13, "tasks": ["21.1", "21.2", "21.3", "21.4", "21.5", "21.6", "21.7"] },
    { "id": 14, "tasks": ["22.1", "22.2", "22.3", "22.4"] }
  ]
}
```
