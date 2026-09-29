# Skribbl — Real-time Multiplayer Drawing Game

A Pictionary-style drawing and guessing game built with **FastAPI** (Python) and **React 18** (TypeScript). Players create or join rooms, take turns drawing words on a shared canvas while others race to guess correctly via chat.

![Python](https://img.shields.io/badge/Python-3.12-blue)
![Go](https://img.shields.io/badge/Go-1.22-00ADD8)
![React](https://img.shields.io/badge/React-18-61DAFB)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688)
![gRPC](https://img.shields.io/badge/gRPC-Bidirectional%20Streaming-244c5a)
![Tests](https://img.shields.io/badge/Tests-330%20backend%20%2B%20151%20frontend%20passing-brightgreen)
![Benchmark](https://img.shields.io/badge/Validated%20Scale-120%2C000%20VUs%20%40%2020Hz-purple)
![Throughput](https://img.shields.io/badge/Messages-400M%20Processed-blueviolet)
![Bandwidth](https://img.shields.io/badge/Peak%20Bandwidth-1.50%20Gbps-success)
![Observability](https://img.shields.io/badge/Metrics-Prometheus%20%2B%20Grafana-orange)

## Features

**Game Mechanics & Creative Canvas**
- 🎨 **Real-Time Canvas:** Pen, Eraser, Flood Fill, Highlighter, and Geometric Shapes (Line, Rectangle, Circle) with interactive preview.
- 📐 **Shape Snapping:** Hold `Shift` while dragging to constrain rectangles to perfect squares, ellipses to circles, and lines to 45°/90° angles.
- ⚡ **60 FPS Stroke Batching & Smoothing:** Ultra-smooth quadratic Bézier curves and 16ms animation-frame batching for lag-free remote rendering.
- ↩️ **Full Stroke Undo & Redo:** Canvas history operates per complete stroke or shape rather than intermediate packet fragments, synchronized room-wide.
- 🎨 **Palette & Brushes:** 16 vibrant colors + custom HEX/RGB color picker, 5 brush sizes (XS, S, M, L, XL), and brush cursor preview.
- 📚 **Theme Packs & Word Selection:** 3 thematic packs (Animals, Food, Fantasy, etc.) displayed in tabs during word selection + custom word injection.
- 💬 **Live Chat & Close Guess:** Guessing chat with profanity filtering; guesses within Levenshtein distance $\le 2$ trigger private `"is very close!"` alerts.
- 🏆 **Exponential Scoring & Streaks:** Speed-decay scoring with position multipliers (1st = 1.5x), consecutive guess streaks, and drawer bonuses.
- 🔁 **Round Transitions & Replay Gallery:** Animated round overlays, end-of-game interactive time-lapse drawing replay with scrubbers and speed controls (0.5x–4x).
- 📸 **Shareable Scorecards:** One-click image download and clipboard copy for post-game match result cards.

**Room Management & Social**
- 🚪 **Flexible Room Access:** 6-character room codes, private rooms with password protection, and QR Code modals with Web Share API.
- 👑 **Host Controls:** Settings configuration (rounds, duration, max players, custom words), player kicking, and host transfer.
- 🗳️ **Democratic Vote Kick:** Players can initiate vote-kicks requiring a calculated majority, with real-time progress banners.
- 👀 **Spectator Mode & Mid-Game Join:** Join ongoing matches as a spectator; request host promotion to active player (capped at 2 requests per game to prevent spam).
- 🛡️ **Host Join Approval:** When players join an in-progress game, the host receives an approval prompt to accept as player, accept as spectator, or decline.
- 🎭 **Custom Avatars & Profiles:** 8 persistent animal avatars with in-lobby profile editing and name customization.
- 😂 **Floating Reactions & Typing:** Live floating emoji reaction burst engine and real-time typing indicators in chat and player list.
- 🔊 **Web Audio Sound Effects:** Zero-external-asset synthesized audio engine for ticking timers, correct guesses, turn wins, and fanfares.
- 🌓 **Theme Selector:** Client-side theming support with multiple color schemes.

## Tech Stack

| Layer | Technology |
|---|---|
| Edge Gateway | Go 1.22, Gorilla WebSocket, gRPC client, Epoll event loop |
| Backend | Python 3.12, FastAPI, gRPC servicer, `orjson` (Rust JSON), asyncio |
| Frontend | React 18, TypeScript, Vite, React Router v6 |
| IPC / Inter-Tier | gRPC bidirectional streaming (`RoomStream`) with Protobuf bytes |
| Multi-Worker State | Redis 7 (AOF persistence, local-first pub/sub bypass, worker discovery) |
| Reverse Proxy | Nginx (consistent hashing by room and client ID) |
| Observability | 1-second `/proc` cluster metrics monitor, k6 telemetry, structured logs |
| Testing | pytest + Hypothesis (284 tests), Vitest, k6 distributed suite |
| Cloud IaC | Terraform (AWS, Azure, OCI) |

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
# Backend (330 tests — unit + property-based + integration + metrics + undo + spectator)
python -m pytest backend/tests/ -v

# Frontend (151 tests — component + reducer + canvas + shape tools + audio + spectator)
cd frontend && npx vitest run

# Performance test (simulates concurrent WebSocket clients)
python scripts/perf_test.py --clients 100

# Performance test with sticky sessions (multi-worker)
python scripts/perf_test_sticky.py --host localhost --port 8080 --clients 10
```

## Observability & Metrics (Prometheus & Grafana)

The platform includes an out-of-the-box telemetry stack exposing real-time worker and gateway metrics.

- **FastAPI `/metrics`**: Exposes active rooms, connected players, gRPC streaming channels, turn durations, and message/guess counters.
- **Go Gateway `/metrics`**: Exposes active WebSockets, epoll queue size, lossy vs. control drops, and network fanout throughput.

To launch the pre-configured Prometheus & Grafana stack:
```bash
docker compose -f monitoring/docker-compose.yml up -d
```
- **Prometheus**: Accessible at `http://localhost:9090`
- **Grafana**: Accessible at `http://localhost:3000` (auto-loaded dashboard: `Skribbl Cluster Overview`)


### Performance Results (100 clients)

| Metric | Value |
|--------|-------|
| Connection establishment | 5.7ms avg |
| Room creation RTT | 1.0ms avg |
| Stroke broadcast latency | 1.1ms avg (P95: 1.85ms) |
| Concurrent connections | 500/500 established |
| Message throughput | 6,781 msgs/sec |

### Enterprise Scale Milestone (AWS Distributed Cluster — 100,000–120,000 VUs)

Tested on AWS across a 17-node distributed fleet (1 × `c5a.4xlarge` Nginx Load Balancer, 6 × `c5a.2xlarge` Go Gateways [18 containers], 8 × `c5a.2xlarge` Python Workers [48 containers], 1 × `c5a.xlarge` Redis, and 4 × `c5a.8xlarge` distributed load generators):

| Scale Metric | Validated 100,000 VU Run | 120,000 VU Distributed Run (4 Runners) | Target SLA |
|---|---|---|---|
| **Concurrent Players (VUs)** | **100,000 VUs** | **120,000 VUs** | Fleet Target |
| **WebSocket Connection Success** | **99.06%** (96,441 conns) | **100.00%** (120,000 conns, 0 drops) | $\ge 99.0\%$ ✅ |
| **Game Completion Rate** | **97.29%** (19,251 rooms) | **99.98%** (24,000 rooms) | $\ge 80.0\%$ ✅ |
| **Player Session Completion** | **99.44%** (95,745 games) | **99.99%** (119,993 games) | $\ge 80.0\%$ ✅ |
| **Server Create Errors** | **0** (100% eliminated) | **0** (100% eliminated) | 0 ✅ |
| **Total Messages Processed** | **212,504,506 messages** | **399,587,754 messages** | Sustained throughput |
| **Peak Fleet Bandwidth** | **1.43 Gbps TX / 1.36 Gbps RX** | **1.38 Gbps TX / 1.28 Gbps RX** | AWS Line Rate |
| **Gateway Control Drops** | **0 drops** | **0 control drops, 0 lossy drops** | 0 drops ✅ |
| **Python Worker Memory** | **2,057 MB max** (<13% RAM) | **1,659 MB max** (<11% RAM) | Zero OOMs ✅ |

See the full [Performance Test Report](docs/performance-test-report.md) for detailed telemetry.

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
| `create_room` | Create a new room (supports password) |
| `join_room` | Join existing room (supports password, spectator flag) |
| `reconnect` | Reconnect to room after page refresh |
| `start_game` | Host starts game |
| `select_word` | Drawer picks word from theme packs or custom list |
| `stroke` | Freehand drawing batch (60fps smoothed) |
| `shape` | Geometric shape (line, rectangle, circle) |
| `highlighter` | Semitransparent highlighter stroke |
| `fill` | Flood fill operation |
| `clear_canvas` | Clear the canvas |
| `undo` | Undo last stroke/shape |
| `guess` | Submit a guess |
| `chat` | Send chat message (lobby or in-game for drawer/spectators) |
| `reaction` | Emoji reaction |
| `typing` | Typing indicator status |
| `toggle_ready` | Ready status in lobby |
| `update_profile` | Change player name or avatar |
| `transfer_host` | Host transfers room leadership |
| `vote_kick` | Initiate a democratic vote-kick |
| `vote_kick_cast` | Cast vote (yes/no) in active vote-kick |
| `respond_join_request` | Host responds to mid-game join request (`accept_player`, `accept_spectator`, `decline`) |
| `cancel_join_request` | Cancels pending mid-game join request |
| `request_become_player` | Spectator requests host to become an active player (max 2 attempts) |
| `respond_spectator_role_request` | Host accepts or declines spectator promotion |
| `cancel_spectator_role_request` | Spectator cancels pending promotion request |
| `kick_player` | Host kicks player directly |
| `leave_room` | Leave voluntarily |
| `rematch` | Host starts new game (preserves session stats) |
| `end_game_now` | Host ends game immediately during disconnect countdown |
| `update_settings` | Host changes game config (rounds, duration, max players, custom words) |

| Server → Client | Description |
|-----------------|-------------|
| `room_created` | Confirms room creation |
| `room_joined` | Confirms join with full state and spectator flag |
| `reconnected` | Confirms reconnection with restored state |
| `error` | Error response with code + message |
| `player_list` | Updated player list broadcast (with avatar, spectator status, streaks) |
| `settings_updated` | Config change broadcast |
| `profile_updated` | Confirms profile name/avatar update |
| `game_started` | Game begins |
| `word_choices` | Sent only to Drawer (3 words + theme packs) |
| `drawer_selecting` | Broadcast: drawer is choosing a word |
| `word_assigned` | Sent to drawer on auto-select |
| `turn_started` | Turn begins with hint + duration + theme |
| `hint_update` | Partial reveal broadcast to Guessers |
| `stroke` / `shape` / `highlighter` / `fill` / `clear_canvas` / `undo` | Drawing broadcasts |
| `guess_correct` | A guesser guessed correctly |
| `chat_message` | Chat message broadcast (with system / close guess alerts) |
| `typing` | Typing indicator broadcast |
| `turn_ended` | Turn over; word revealed, scores updated |
| `game_over` | Final ranked scores, MVP awards, and session stats |
| `player_reconnected` | Reconnected player restored |
| `waiting_for_reconnect` | Countdown before ending game on disconnect |
| `reconnect_resumed` | Player reconnected, countdown cancelled |
| `rematch_started` | New game starting (preserves cumulative stats) |
| `host_transferred` / `host_changed` | Room host reassignment broadcast |
| `join_request_pending` | Sent to joiner while waiting for host approval |
| `join_request_received` | Sent to host with joiner details and action buttons |
| `join_request_resolved` / `join_request_declined` | Join request resolution notifications |
| `become_player_request_pending` | Sent to spectator with remaining attempts |
| `spectator_role_request_received` | Sent to host when spectator requests player role |
| `spectator_role_request_resolved` / `spectator_role_request_declined` | Spectator role resolution |
| `vote_kick_started` / `vote_kick_updated` / `vote_kick_ended` | Real-time vote kick tally and result |
| `kicked` | Player was kicked |
| `left_room` | Player left confirmation |
| `reaction` | Emoji reaction broadcast |
| `game_ended_insufficient_players` | Game ended (< 2 active players) |

## Pre-commit Hooks

Smart pre-commit hook that only checks files you've actually changed:
- **Frontend changes**: Prettier → TypeScript → Build → Related tests
- **Backend changes**: Full pytest suite (if source changed) or just changed test files
- **No changes in a layer**: Skips that layer entirely

## License

MIT
