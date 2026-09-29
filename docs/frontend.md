# Frontend Architecture

## Overview

The frontend is a React 18 SPA built with Vite and TypeScript. It's a thin rendering layer — all game logic is enforced by the server. The frontend's job is to:

1. Display game state received from the server
2. Capture user input (drawing, guessing, settings) and send it to the server
3. Handle navigation between views based on game phase

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| React | 18.2.0 | UI framework |
| TypeScript | 5.4.5 | Type safety |
| Vite | 5.2.8 | Build tool + dev server |
| React Router | 6.22.3 | Client-side routing |
| Vitest | 1.5.0 | Test runner |
| React Testing Library | 14.3.1 | Component testing |
| Prettier | 3.9.0 | Code formatting |

## Application Structure

```
frontend/src/
├── main.tsx                    # Entry point: ReactDOM.createRoot + providers
├── App.tsx                     # React Router routes
├── index.css                   # Global styles and theme tokens
├── setupTests.ts              # Test configuration & mocks
├── context/
│   ├── WebSocketContext.tsx    # WebSocket + state management (the brain)
│   ├── drawingBus.ts           # Synchronous event bus for remote drawing stream
│   └── reactionBus.ts          # Event bus for floating animated reactions
├── pages/
│   ├── Landing.tsx            # Create/join room form, spectator toggle, password input
│   ├── Lobby.tsx              # Pre-game room, custom word creator, settings, presets
│   ├── Game.tsx               # Active game view, themes, word packs, spectator banner
│   └── GameOver.tsx           # Final scores, replay modal, MVP awards, scorecard
├── components/
│   ├── Canvas.tsx             # Drawing canvas, toolbars, shape tools, color picker
│   ├── Chat.tsx               # Chat/guess input, typing indicators, close guess
│   ├── PlayerList.tsx         # Player names, scores, avatars, streaks, mute, vote-kick
│   ├── TimerBar.tsx           # Countdown progress bar
│   ├── RoundTransition.tsx    # Animated round overlay
│   ├── AvatarPicker.tsx       # 8-animal selectable avatar picker
│   ├── ProfileModal.tsx       # In-lobby profile and name editor
│   ├── QRCodeModal.tsx        # Dynamic SVG QR code modal for mobile invites
│   ├── ReactionToolbar.tsx    # Floating emoji reaction trigger bar
│   ├── FloatingReactions.tsx  # Canvas floating emote physics renderer
│   ├── HeaderBar.tsx          # Minimalist game top bar
│   ├── VoteKickBanner.tsx     # Democratic vote-kick tally banner
│   ├── ScorecardModal.tsx     # Exportable PNG scorecard dialog
│   ├── SoundToggle.tsx        # Client-side audio mute/unmute control
│   ├── ThemeSelector.tsx      # Dark/Light/Custom theme picker
│   └── Confetti.tsx           # Celebratory particle burst on win/correct guess
├── hooks/
│   ├── useCanvas.ts           # Canvas drawing logic, 60fps batching, quadratic Bézier
│   ├── useGameAudio.ts        # Automated sound triggers for game lifecycle
│   └── useWebSocket.ts       # Context consumer hook
├── utils/
│   ├── soundEffects.ts        # Synthesized Web Audio API sound effects engine
│   ├── shapeSnap.ts           # Shift-key geometric constraint calculations
│   ├── shareCard.ts           # Graphical scorecard generator & clipboard copy
│   ├── avatars.ts             # Animal avatar mapping & random generator
│   ├── clipboard.ts           # Async clipboard API wrapper with fallbacks
│   ├── qr.ts                  # Pure client-side SVG QR code generator
│   └── theme.ts               # CSS custom properties theme manager
└── types/
    └── index.ts               # Shared TypeScript interfaces & Action unions
```

## State Management

### Global State: `useReducer` in Context

All shared game state lives in `WebSocketContext` via React's `useReducer`. The reducer is a pure function that handles all server messages.

```
Server message → mapKeys (snake→camel) → dispatch(action) → new GameState
```

**Key state fields:**

| Field | Type | Description |
|-------|------|-------------|
| `phase` | `GamePhase` | Current game phase (`idle`/`lobby`/`word_selection`/`playing`/`game_over`) |
| `roomCode` | `string | null` | Current room code |
| `localPlayerId` | `string | null` | This player's server-assigned ID |
| `isHost` | `boolean` | Whether this player is the room host |
| `isDrawer` | `boolean` | Whether this player is currently drawing |
| `isSpectator` | `boolean` | Whether this player is spectating without guessing |
| `players` | `PlayerInfo[]` | All players with scores, avatar, streaks, and spectator state |
| `config` | `GameConfig` | Game configuration (rounds, duration, max players, custom words) |
| `hint` | `string[]` | Current hint (array of characters and underscores) |
| `wordPacks` | `WordPackChoice[]` | 3 curated theme word packs for the drawer |
| `currentTheme` | `RoundTheme | null` | Active theme for the ongoing round |
| `timerSeconds` | `number` | Turn countdown (decremented locally via TICK) |
| `chatMessages` | `ChatMessage[]` | Chat history (chat, correct_guess, system) |
| `artworkGallery` | `RoundArtwork[]` | Historical round drawings with full replay action streams |
| `activeVoteKick` | `ActiveVoteKick | null` | Active vote-kick poll metadata and progress |
| `joinRequestPending` | `boolean` | Whether local player is waiting for host approval to join |
| `pendingJoinRequests` | `JoinRequest[]` | Host's queue of players requesting to join |
| `spectatorRoleRequestPending`| `boolean` | Whether spectator's request to become a player is pending |
| `spectatorRequestsRemaining` | `number` | Remaining attempts to request player role (max 2 per game) |

### Synchronous Drawing Bus (`drawingBus.ts`)

Rapid bursts of drawing messages (`stroke`, `shape`, `highlighter`, `fill`, `undo`, `clear_canvas`) bypass React's asynchronous state batching. They publish directly to a dedicated pub/sub drawing bus, ensuring 60 FPS zero-latency drawing synchronization without dropped strokes or dashes.

### Synthesized Sound Engine (`soundEffects.ts`)

Zero external audio asset dependencies. Uses the native browser Web Audio API oscillator synthesis:
- **Ticking countdown**: Ascending pitch warning below 10 seconds.
- **Correct guess**: Cheerful two-tone chime.
- **Turn win / Game over**: Victorious chord progression.
- **Sound Toggle**: Remembers mute preference in `localStorage`.

---

## Component Details

### Canvas (`Canvas.tsx` + `useCanvas.ts`)

- **High-Performance Streaming**: `requestAnimationFrame` 60 FPS batching with quadratic Bézier curve interpolation.
- **Tool Suite**: Pen, Eraser, Highlighter, Flood Fill (BFS), Line, Rectangle, Circle.
- **Geometric Snapping**: Holding `Shift` constrains rectangles to 1:1 squares, ellipses to circles, and lines to 45°/90° angles.
- **Full Stroke Undo/Redo**: History records whole strokes and shapes rather than fragmented chunks; drawer echo prevention protects local action stacks.
- **Coordinate Normalization**: Automatically compensates for CSS container scaling and display pixel ratios.

### Spectator Banner & Host Approval (`Game.tsx`)

- **Spectator Banner**: Displays live spectating badge, allows requesting active player role (capped at 2 attempts per game), and provides request cancellation.
- **Host Approval Banner**: Displays card-based prompts when new players join mid-game (Accept as Player / Accept as Spectator / Decline) or when spectators request promotion.

### Vote-Kick System (`VoteKickBanner.tsx`)

- Interactive non-intrusive floating banner when a vote-kick is initiated.
- Displays live vote tally, required threshold (majority of eligible players), and vote cast buttons.

### Interactive Replay Modal (`GameOver.tsx`)

- Re-renders any completed round's artwork stroke-by-stroke using the saved `replayActions` vector stream.
- Includes play/pause, scrub slider, and speed toggles (0.5x, 1x, 2x, 4x).

---

## Build & Test

```bash
# Development server
npm run dev

# TypeScript type check
npx tsc --noEmit

# Vitest test suite (151 tests)
npm test

# Prettier format check
npm run format
```
