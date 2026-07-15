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
├── index.css                   # Global styles
├── setupTests.ts              # Test configuration
├── context/
│   └── WebSocketContext.tsx    # WebSocket + state management (the brain)
├── pages/
│   ├── Landing.tsx            # Create/join room form
│   ├── Lobby.tsx              # Pre-game waiting room
│   ├── Game.tsx               # Active game view
│   └── GameOver.tsx           # Final scores + rematch
├── components/
│   ├── Canvas.tsx             # Drawing canvas + toolbar
│   ├── Chat.tsx               # Chat/guess input + message feed
│   ├── PlayerList.tsx         # Player names, scores, status
│   ├── TimerBar.tsx           # Countdown progress bar
│   └── RoundTransition.tsx    # Animated round overlay
├── hooks/
│   ├── useCanvas.ts           # Canvas drawing logic
│   └── useWebSocket.ts       # Context consumer hook
├── types/
│   └── index.ts               # Shared TypeScript interfaces
└── __tests__/
    ├── gameReducer.test.ts    # Reducer unit tests
    ├── Landing.test.tsx       # Landing page tests
    ├── Lobby.test.tsx         # Lobby page tests
    ├── Game.test.tsx          # Game page tests
    ├── Chat.test.tsx          # Chat component tests
    ├── Canvas.test.tsx        # Canvas component tests
    └── GameOver.test.tsx      # GameOver page tests
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
| `phase` | `GamePhase` | Current game phase (idle/lobby/word_selection/playing/game_over) |
| `roomCode` | `string | null` | Current room code |
| `localPlayerId` | `string | null` | This player's server-assigned ID |
| `isHost` | `boolean` | Whether this player is the room host |
| `isDrawer` | `boolean` | Whether this player is currently drawing |
| `players` | `PlayerInfo[]` | All players with scores and status |
| `config` | `GameConfig` | Game configuration (rounds, duration, max) |
| `hint` | `string[]` | Current hint (array of chars / underscores) |
| `timerSeconds` | `number` | Turn countdown (decremented locally via TICK) |
| `chatMessages` | `ChatMessage[]` | Chat history |
| `drawingEvent` | `object | null` | Latest remote drawing event to render |

### Local State: `useState` in Components

Component-specific state that doesn't need to be shared:

- Form inputs (player name, room code, guess text)
- Drawing tool state (color, brush size, active tool)
- UI toggles (showing/hiding elements)

## Routing

| Route | Page | Phase |
|-------|------|-------|
| `/` | `Landing.tsx` | `idle` |
| `/lobby/:roomCode` | `Lobby.tsx` | `lobby` |
| `/game/:roomCode` | `Game.tsx` | `word_selection` / `playing` |
| `/gameover/:roomCode` | `GameOver.tsx` | `game_over` |

Navigation is driven by `gameState.phase` changes — when the phase transitions, the page calls `useNavigate()` to push the new route.

## WebSocket Connection

### Connection Lifecycle

1. `WebSocketProvider` mounts → creates WebSocket to `ws://<host>/ws`
2. On `open` → checks `sessionStorage` for stored session, attempts reconnect
3. On `message` → parses JSON, maps snake_case → camelCase, dispatches action
4. On `close` → sets `isConnected = false`

### Auto-Reconnect on Page Refresh

Session info (player name + room code) is stored in `sessionStorage`. On WebSocket open:
- If the URL is `/game/*` or `/lobby/*` → sends `reconnect` message
- Server restores full game state in the `reconnected` response
- Works within the 120-second grace window

### Snake-to-CamelCase Mapping

All incoming payloads are recursively converted:
```
room_code → roomCode
player_id → playerId
is_host → isHost
```

## Component Details

### Canvas (`Canvas.tsx` + `useCanvas.ts`)

The drawing system uses HTML5 Canvas with these features:

- **Real-time streaming**: Each `mousemove` emits a 2-point stroke segment immediately (not batched)
- **Coordinate scaling**: Accounts for CSS responsive scaling via `canvas.width / rect.width`
- **Tools**: Pen, eraser (white stroke), fill (BFS flood-fill), clear
- **Remote rendering**: `renderRemoteStroke()` and `renderRemoteFill()` handle incoming server events
- **Permission gating**: All pointer handlers are no-ops when `isDrawer === false`

### Chat (`Chat.tsx`)

- Scrollable message feed with auto-scroll on new messages
- Input sends `guess` (for guessers) or `chat` (for drawer/lobby)
- Input disabled when `hasGuessed === true`
- Three message styles: `chat`, `correct_guess`, `system`

### RoundTransition (`RoundTransition.tsx`)

Animated overlay between rounds:
1. Slides up from bottom (400ms)
2. Pauses showing "Round N / M" (500ms)
3. Slides up and out (400ms)
4. Calls `onComplete` callback

### PlayerList (`PlayerList.tsx`)

Pure presentational component showing:
- Player names
- Scores
- Host indicator (crown)
- Connection status (connected/disconnected)
- Guessed status (checkmark during turns)
- Ready status (in lobby)

## Build & Serve

### Development

```bash
npm run dev    # Vite dev server with HMR + WS proxy
```

### Production Build

```bash
npm run build  # tsc --noEmit && vite build → dist/
```

Output goes to `frontend/dist/` which FastAPI serves as static files:
- `/assets/*` → static JS/CSS bundles
- `/*` → `index.html` (SPA catch-all for client-side routing)

## Testing Approach

All component tests use a mock `WebSocketContext` provider:

```tsx
// Test wrapper provides mock gameState and send function
const mockSend = vi.fn();
const wrapper = ({ children }) => (
  <WebSocketContext.Provider value={{ gameState: mockState, send: mockSend, dispatch: vi.fn(), isConnected: true }}>
    <MemoryRouter initialEntries={['/game/ABC123']}>
      {children}
    </MemoryRouter>
  </WebSocketContext.Provider>
);
```

This isolates components from the real WebSocket and lets tests verify:
- Correct elements render based on state
- User interactions call `send()` with correct message types
- Navigation happens on phase transitions
