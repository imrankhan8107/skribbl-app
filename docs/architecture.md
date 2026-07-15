# Architecture

## System Overview

Skribbl is a real-time multiplayer drawing game with a two-tier architecture:

- **Backend**: Python 3.12 + FastAPI — manages all game state in-memory, enforces rules, handles WebSocket communication
- **Frontend**: React 18 SPA (TypeScript, Vite) — thin rendering layer with no game logic

All communication happens over a single WebSocket connection per player. The server is the single source of truth for game state.

## High-Level Architecture

```
Browser (React SPA)          Server (FastAPI)
┌─────────────────┐         ┌──────────────────────┐
│  WebSocketContext│◄──WS──►│  ws_handler.py        │
│  gameReducer     │         │  ├── room_manager.py  │
│  useCanvas hook  │         │  ├── game_engine.py   │
│  Pages/Components│         │  ├── heartbeat.py     │
└─────────────────┘         │  ├── redis_pubsub.py  │
                             │  └── models.py        │
                             └──────────────────────┘
```

## Backend Components

### `ws_handler.py` — WebSocket Lifecycle

Entry point for all client connections. Accepts the WebSocket, starts a heartbeat task, and enters a message dispatch loop. Routes each message type to the appropriate handler in `RoomManager` or `GameEngine`.

On disconnect (clean or unexpected), it stops the heartbeat and delegates to `RoomManager.handle_disconnect()`.

### `room_manager.py` — Room CRUD & Player Management

Owns the in-memory registry of all active rooms. Key responsibilities:

- **Room lifecycle**: Create, join, delete rooms
- **Player management**: Add, remove, kick, leave, ready toggle
- **Host controls**: Settings updates, game start, rematch
- **Disconnection/reconnection**: 120-second grace window with cleanup tasks
- **Broadcasting**: Send messages to all players in a room
- **Redis integration**: Cross-worker message relay when Redis is configured

Uses O(1) lookups via:
- `_rooms: dict[str, Room]` — room_code → Room
- `_player_to_room: dict[str, str]` — player_id → room_code

### `game_engine.py` — Game Logic

State machine for each room's game session:

- Turn lifecycle: word selection → playing → turn end → next turn
- Round management: track drawer rotation, advance rounds, game over
- Scoring: exponential decay + position multiplier
- Hint progression: reveals at 40% and 70% elapsed
- Guess evaluation: case-insensitive matching, lockout after correct guess
- Disconnection handling: skip disconnected drawers, end turn on drawer disconnect

### `heartbeat.py` — Connection Health

Background asyncio task per connection that sends a WebSocket ping every 30 seconds. If no pong within 10 seconds, the connection is forcibly closed.

### `redis_pubsub.py` — Multi-Worker Support

Optional Redis adapter activated when `REDIS_URL` is set:

- Publishes room broadcasts to Redis channels
- Subscribes to channels and relays messages to local players
- Generates unique worker IDs for sticky session routing

### `models.py` — Data Models

Python dataclasses:
- `Player` — id, name, score, connection state, ready status
- `Room` — code, host, players, config, game state, turn state
- `GameConfig` — rounds, duration, max players
- `TurnState` — drawer, word, hint, timers, guess order
- `RoomState` — enum: LOBBY, WORD_SELECTION, PLAYING, GAME_OVER

## Data Flow

### Single-Worker Mode

```
Client A ──WS──► FastAPI ──► RoomManager ──► broadcast ──► Client B
                              └──► GameEngine
```

### Multi-Worker Mode (Redis)

```
Client A ──WS──► Worker 1 ──► RoomManager ──► Redis pub/sub ──► Worker 2 ──► Client B
                     │                              │
                     └── nginx (sticky sessions) ◄──┘
```

## Deployment Topology

### Single Container (Development / Small Scale)

```
┌─────────────────────────────────────────┐
│  Docker Container                        │
│  ┌─────────────────────────────────────┐│
│  │  uvicorn (FastAPI)                   ││
│  │  ├── WebSocket API (/ws)            ││
│  │  └── Static files (frontend/dist/)  ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

### Multi-Worker (Production Scale)

```
┌──────────┐     ┌──────────────────────────────────────────────┐
│  Browser  │────►│  nginx (port 80)                             │
└──────────┘     │  ├── ip_hash + worker_id cookie routing      │
                 │  ├── WebSocket upgrade (HTTP/1.1)             │
                 │  └── 86400s timeouts                          │
                 └──────────────────────────────────────────────┘
                          │            │            │
                 ┌────────┴─┐  ┌───────┴──┐  ┌─────┴────┐
                 │ Worker 1  │  │ Worker 2  │  │ Worker 3  │
                 └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
                       └──────────────┼──────────────┘
                              ┌───────┴───────┐
                              │  Redis 7      │
                              │  (pub/sub)    │
                              └───────────────┘
```

## Key Design Decisions

### In-Memory State (No Database)

Game state is ephemeral — rooms exist only while players are connected. This gives:
- Sub-millisecond state access
- Zero external dependencies for single-worker mode
- Simple code with no ORM or query layer

Trade-off: State is lost on process restart. Acceptable for a casual game.

### Server-Authoritative

The server enforces all game rules. The frontend never validates guesses, computes scores, or advances turns. This prevents cheating and ensures consistency across clients.

### Sticky Sessions for Multi-Worker

When scaling with Redis, sticky sessions ensure most traffic stays on the same worker (fast local path). Redis relay is only needed when players in the same room land on different workers — a rare edge case with proper cookie routing.

### asyncio Tasks for Timers

Turn timers, hint reveals, and cleanup tasks are implemented as `asyncio.Task` objects. This avoids external schedulers and keeps everything in a single event loop.
