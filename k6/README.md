# k6 Load Tests — Skribbl App

## Test Scripts

| Script | Purpose | Rating |
|--------|---------|--------|
| `ws_e2e_game.js` | Standalone per-VU game simulation (no coordination needed) | WebSocket capacity + basic game flow |
| `ws_e2e_coordinated.js` | **True multiplayer** — 5 VUs form one room and play together | Full E2E game simulation |

## Quick Start

### Option A: Standalone test (no coordination server)

Each VU creates its own room and simulates a solo game flow.
Good for testing WebSocket capacity, connection handling, and message throughput.

```bash
k6 run k6/ws_e2e_game.js
k6 run --env VUS=100 --env HOST=localhost --env PORT=8000 k6/ws_e2e_game.js
```

### Option B: Coordinated multiplayer test (recommended)

True multiplayer: 5 VUs join the same room and play a full game.

```bash
# Terminal 1: Start your app
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# Terminal 2: Start coordination server
python k6/coord_server.py --port 9090

# Terminal 3: Run the test
k6 run k6/ws_e2e_coordinated.js
k6 run --env VUS=250 --env COORD_PORT=9090 k6/ws_e2e_coordinated.js
```

## Test Levels

| Level | VUs | Rooms | Players/Room | Command |
|-------|-----|-------|--------------|---------|
| Baseline | 50 | 10 | 5 | `k6 run --env VUS=50 k6/ws_e2e_coordinated.js` |
| Normal | 250 | 50 | 5 | `k6 run --env VUS=250 k6/ws_e2e_coordinated.js` |
| Production | 500 | 100 | 5 | `k6 run --env VUS=500 k6/ws_e2e_coordinated.js` |
| Stress | 1000 | 200 | 5 | `k6 run --env VUS=1000 k6/ws_e2e_coordinated.js` |
| Breaking | 2000+ | 400+ | 5 | `k6 run --env VUS=2000 k6/ws_e2e_coordinated.js` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `localhost` | Target server hostname |
| `PORT` | `8000` | Target server port |
| `COORD_PORT` | `9090` | Coordination server port |
| `VUS` | `50` | Number of virtual users |
| `PLAYERS_PER_ROOM` | `5` | Players per room |
| `NUM_ROUNDS` | `3` | Game rounds per session |
| `TURN_DURATION` | `80` | Turn duration in seconds |
| `HOLD_TIME` | `300`/`600` | Max connection hold time (seconds) |

## Key Metrics

### Connection Health
- `ws_connect_rtt` — WebSocket handshake time
- `ws_connection_success` — Connection success rate
- `ws_connection_failures` — Total failed connections

### Room Lifecycle
- `room_create_rtt` — Time to create a room
- `room_join_rtt` — Time to join an existing room
- `rooms_created` / `rooms_joined` — Successful operations
- `room_create_failures` / `room_join_failures` — Failed operations

### Game Lifecycle
- `game_start_rtt` — Time from start_game to first turn
- `games_started` / `games_completed` / `games_aborted`
- `game_completion_rate` — % of games that reached game_over

### Message Performance
- `guess_broadcast_rtt` — Time from guess sent to broadcast received
- `draw_broadcast_rtt` — Time from stroke sent to broadcast received
- `messages_sent` / `messages_received` — Total message throughput
- `drawing_events_sent` — Stroke + fill events

### Errors
- `errors` — Total error count
- `disconnects` — Unexpected disconnections

## Architecture

```
┌─────────────────────────────────────────────────┐
│                k6 Test Runner                     │
├─────────────────────────────────────────────────┤
│  VU 1 (Host)──┐                                 │
│  VU 2 ────────┼──→ Room 0 (via coord server)    │
│  VU 3 ────────┤                                 │
│  VU 4 ────────┤                                 │
│  VU 5 ────────┘                                 │
│                                                  │
│  VU 6 (Host)──┐                                 │
│  VU 7 ────────┼──→ Room 1 (via coord server)    │
│  VU 8 ────────┤                                 │
│  VU 9 ────────┤                                 │
│  VU 10 ───────┘                                 │
│  ...                                             │
└─────────────────────────────────────────────────┘
         │                        │
         │ HTTP (room codes)      │ WebSocket (game)
         ▼                        ▼
┌────────────────┐    ┌─────────────────────┐
│  Coord Server  │    │   Skribbl Backend   │
│  (port 9090)   │    │   (port 8000)       │
└────────────────┘    └─────────────────────┘
```

## Game Lifecycle Simulated

```
CONNECT
  ↓
CREATE/JOIN ROOM (via coordination)
  ↓
LOBBY (toggle_ready)
  ↓
HOST: start_game
  ↓
ROUND 1
  ├── Drawer receives word_choices
  ├── Drawer sends select_word
  ├── turn_started broadcast
  ├── Drawer: 4-10 strokes (15-80 points each)
  ├── Guessers: 4-10 guesses with realistic timing
  ├── hint_update at 40% and 70%
  ├── guess_correct / turn_ended
  └── Emoji reactions, chat
  ↓
ROUND 2...N
  ↓
game_over
  ↓
DISCONNECT
```

## Coordination Server

The `coord_server.py` is a zero-dependency Python HTTP server that lets k6 VUs
share room codes. It's the piece that makes true multiplayer testing possible.

```bash
# Start with defaults (port 9090)
python k6/coord_server.py

# Custom port
python k6/coord_server.py --port 8888

# Check health
curl http://localhost:9090/health

# List active rooms
curl http://localhost:9090/rooms

# Reset between test runs
curl -X POST http://localhost:9090/reset
```
