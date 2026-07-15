# Skribbl — Real-time Multiplayer Drawing Game

A Pictionary-style drawing and guessing game built with **FastAPI** (Python) and **React 18** (TypeScript). Players create or join rooms, take turns drawing words on a shared canvas while others race to guess correctly via chat.

![Python](https://img.shields.io/badge/Python-3.12-blue)
![React](https://img.shields.io/badge/React-18-61DAFB)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-green)
![Tests](https://img.shields.io/badge/Tests-275%20passing-brightgreen)

## Features

**Game Mechanics**
- 🎨 Real-time collaborative canvas with pen, eraser, fill tool, and color picker
- 💬 Live chat with guessing — incorrect guesses visible to all, correct guesses hidden
- 🏆 Exponential scoring with position multiplier (first guesser earns most)
- 🔄 Turn rotation — every player gets to draw each round
- ⏱️ Configurable turn duration (30–180 seconds) with hint reveals at 40% and 70%
- 🎯 Word selection — drawer picks from 3 word choices (auto-selects after 15s)
- 🔁 Round transition animations between rounds

**Room Management**
- 🚪 Create/join rooms with 6-character codes
- 👑 Host controls: kick players, configure settings, start game
- ✅ Ready check system in lobby
- 👋 Leave room voluntarily
- 💬 Lobby chat before game starts

**Resilience**
- 🔌 Auto-reconnect on page refresh (120-second grace window)
- ⏳ 20-second countdown before ending game on disconnect (with "End Now" option for host)
- 🏠 Host reassignment on disconnect
- 🔄 Sticky session support for multi-worker deployments

**Social**
- 😂 Emoji reactions (👍 😂 🔥 ❤️ 👏 😮)
- 🏅 Final leaderboard with rematch option

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, FastAPI, uvicorn, asyncio |
| Frontend | React 18, TypeScript, Vite, React Router v6 |
| Communication | WebSocket (JSON protocol) |
| Testing | pytest + Hypothesis (backend), Vitest + Testing Library (frontend) |
| Multi-worker | Redis pub/sub, nginx sticky sessions |
| Deployment | Docker, nginx, Oracle Cloud / Azure |
| IaC | Terraform (OCI + Azure) |

## Architecture

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

- All game state lives in-memory on the server (single process)
- Frontend is a thin rendering layer — server enforces all rules
- O(1) player lookups via `players_by_id` dict and `_player_to_room` index
- Guess ordering tracked via insertion-order list (no sorting at turn end)
- Multi-worker support via Redis pub/sub with sticky sessions

## Quick Start

### Prerequisites
- Python 3.12+
- Node.js 18+

### Run Locally

```bash
# Backend
pip install -r requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` — the Vite dev server proxies WebSocket to the backend.

### Run on Local Network

Other devices can connect via your machine's IP:
```bash
# Backend already binds to 0.0.0.0
# Frontend with --host flag (already configured in vite.config.ts)
cd frontend && npm run dev
```

Access from other devices: `http://<your-ip>:5173`

## Testing

```bash
# Backend (213 tests — unit + property-based + integration)
python -m pytest backend/tests/ -v

# Frontend (62 tests — component + reducer)
cd frontend && npx vitest run

# Performance test (simulates concurrent WebSocket clients)
python scripts/perf_test.py --clients 100

# Performance test with sticky sessions (multi-worker)
python scripts/perf_test_sticky.py --host localhost --port 8080 --clients 10
```

### Performance Results (100 clients)

| Metric | Value |
|--------|-------|
| Connection establishment | 5.7ms avg |
| Room creation RTT | 1.0ms avg |
| Stroke broadcast latency | 1.1ms avg (P95: 1.85ms) |
| Concurrent connections | 500/500 established |
| Message throughput | 6,781 msgs/sec |

## Deployment

### Oracle Cloud (Always Free Tier)

Deploy on OCI A1.Flex (ARM) with Docker Compose — $0/month:

```bash
cd infra/oci

# Copy and edit variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your OCI credentials

terraform init
terraform plan
terraform apply
```

App is live at `http://<public-ip>` after ~5 minutes (cloud-init builds from source).

See [infra/oci/README.md](infra/oci/README.md) for full instructions.

### Azure Container Apps

```bash
cd infra/azure
terraform init
terraform apply
```

Or use the PowerShell deploy script: `.\infra\azure\deploy.ps1`

Supports scaling to multiple replicas with Azure Cache for Redis for cross-worker synchronization.

See [infra/azure/README.md](infra/azure/README.md) for full instructions.

## Docker

Multi-stage Dockerfile builds both frontend and backend into a single image:

```bash
# Build
docker build -t skribbl-app .

# Run (single worker, no Redis)
docker run -p 80:8000 skribbl-app
```

Then open `http://localhost` — the app serves the built React frontend and WebSocket API from a single container.

**How it works:**
1. Stage 1 (`node:20-alpine`): Installs npm deps, runs `npm run build` → produces `frontend/dist/`
2. Stage 2 (`python:3.12-slim`): Installs Python deps, copies backend + built frontend, runs uvicorn

Image size: ~150MB

## Scaling with Redis (Multi-Worker)

For handling 500–5000+ concurrent players, run multiple app workers with Redis pub/sub for cross-worker message relay:

```bash
# Start 3 workers + Redis + nginx load balancer
docker compose up --build --scale app=3
```

Access at `http://localhost` (nginx on port 80 routes to workers).

**Architecture:**
```
Browser → nginx (port 80, sticky sessions) → Worker 1/2/3 (each with own rooms)
                                                     ↕
                                               Redis pub/sub
                                          (cross-worker relay)
```

**How it works:**
- Each worker holds rooms in-memory (fast local game logic)
- Redis pub/sub relays broadcasts across workers when players in the same room are on different workers
- Sticky session cookie (`worker_id`) ensures the same player reconnects to the same worker
- nginx uses `ip_hash` for initial routing + respects the cookie for subsequent requests
- Without `REDIS_URL` env var, the app runs in single-worker mode (no Redis needed)

**Files involved:**
| File | Purpose |
|------|---------|
| `backend/redis_pubsub.py` | Redis adapter (pub/sub, room registry, worker ID) |
| `docker-compose.yml` | Multi-worker local setup (Redis + nginx + app×N) |
| `nginx.conf` | Load balancer with WebSocket support + sticky sessions |

## Project Structure

```
skribbl-app/
├── backend/
│   ├── main.py              # FastAPI app + WebSocket route + sticky session middleware
│   ├── ws_handler.py        # Message dispatch + connection lifecycle
│   ├── room_manager.py      # Room CRUD, player management, kick/leave/ready
│   ├── game_engine.py       # Turn logic, scoring, hints, word selection
│   ├── models.py            # Dataclasses (Player, Room, TurnState, GameConfig)
│   ├── heartbeat.py         # Ping/pong connection health
│   ├── redis_pubsub.py      # Redis adapter (pub/sub, room registry)
│   ├── words.py             # 200+ word list
│   └── tests/               # 213 tests (unit + property + integration)
├── frontend/
│   ├── src/
│   │   ├── context/         # WebSocketContext + gameReducer
│   │   ├── pages/           # Landing, Lobby, Game, GameOver
│   │   ├── components/      # Canvas, Chat, PlayerList, TimerBar, RoundTransition
│   │   ├── hooks/           # useCanvas, useWebSocket
│   │   └── types/           # TypeScript interfaces
│   └── __tests__/           # 62 component + reducer tests
├── infra/
│   ├── oci/                 # Oracle Cloud terraform (Always Free)
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   ├── cloud-init.tftpl
│   │   └── README.md
│   └── azure/               # Azure Container Apps terraform
│       ├── main.tf
│       ├── deploy.ps1
│       └── README.md
├── scripts/
│   ├── perf_test.py         # WebSocket performance benchmark
│   └── perf_test_sticky.py  # Sticky session performance test
├── Dockerfile               # Multi-stage build
├── docker-compose.yml       # Multi-worker local setup (Redis + nginx)
├── nginx.conf               # Load balancer with WebSocket + sticky sessions
├── requirements.txt         # Python dependencies
└── .husky/pre-commit        # Smart pre-commit (only checks changed files)
```

## Scoring System

Uses exponential decay + position multiplier for differentiated scores:

```
base_score = max(50, round(500 × (1 - elapsed/duration)²))
final_score = round(base_score × multiplier)

Position multipliers: 1st = 1.5x, 2nd = 1.2x, 3rd = 1.0x, 4th+ = 0.9x
```

Drawer bonus = average of all guesser scores for the turn.

## WebSocket Protocol

All messages are JSON: `{ type: "...", payload: {...} }`

| Client → Server | Description |
|----------------|-------------|
| `create_room` | Create a new room |
| `join_room` | Join existing room |
| `reconnect` | Reconnect to room after page refresh |
| `start_game` | Host starts game |
| `select_word` | Drawer picks word from 3 choices |
| `stroke` | Drawing data (real-time) |
| `fill` | Flood fill operation |
| `clear_canvas` | Clear the canvas |
| `guess` | Submit a guess |
| `chat` | Send chat message (lobby or in-game for drawer) |
| `reaction` | Emoji reaction |
| `toggle_ready` | Ready status in lobby |
| `kick_player` | Host kicks player |
| `leave_room` | Leave voluntarily |
| `rematch` | Host starts new game |
| `end_game_now` | Host ends game immediately during disconnect countdown |
| `update_settings` | Host changes game config |

| Server → Client | Description |
|-----------------|-------------|
| `room_created` | Confirms room creation |
| `room_joined` | Confirms join with full state |
| `reconnected` | Confirms reconnection with restored state |
| `error` | Error response with code + message |
| `player_list` | Updated player list broadcast |
| `settings_updated` | Config change broadcast |
| `game_started` | Game begins |
| `word_choices` | Sent only to Drawer (3 words) |
| `drawer_selecting` | Broadcast: drawer is choosing a word |
| `word_assigned` | Sent to drawer on auto-select |
| `turn_started` | Turn begins with hint + duration |
| `hint_update` | Partial reveal broadcast to Guessers |
| `stroke` / `fill` / `clear_canvas` | Drawing broadcasts |
| `guess_correct` | A guesser guessed correctly |
| `chat_message` | Chat message broadcast |
| `turn_ended` | Turn over; word revealed, scores updated |
| `game_over` | Final ranked scores |
| `player_reconnected` | Reconnected player restored |
| `waiting_for_reconnect` | Countdown before ending game on disconnect |
| `reconnect_resumed` | Player reconnected, countdown cancelled |
| `rematch_started` | New game starting |
| `kicked` | Player was kicked |
| `left_room` | Player left confirmation |
| `reaction` | Emoji reaction broadcast |
| `game_ended_insufficient_players` | Game ended (< 2 players) |

## Pre-commit Hooks

Smart pre-commit hook that only checks files you've actually changed:
- **Frontend changes**: Prettier → TypeScript → Build → Related tests
- **Backend changes**: Full pytest suite (if source changed) or just changed test files
- **No changes in a layer**: Skips that layer entirely

## License

MIT
