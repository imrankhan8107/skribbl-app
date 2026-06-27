# Skribbl — Real-time Multiplayer Drawing Game

A Pictionary-style drawing and guessing game built with **FastAPI** (Python) and **React 18** (TypeScript). Players create or join rooms, take turns drawing words on a shared canvas while others race to guess correctly via chat.

![Python](https://img.shields.io/badge/Python-3.12-blue)
![React](https://img.shields.io/badge/React-18-61DAFB)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-green)
![Tests](https://img.shields.io/badge/Tests-274%20passing-brightgreen)

## Features

**Game Mechanics**
- 🎨 Real-time collaborative canvas with pen, eraser, fill tool, and color picker
- 💬 Live chat with guessing — incorrect guesses visible to all, close guesses hidden
- 🏆 Exponential scoring with position multiplier (first guesser earns most)
- 🔄 Turn rotation — every player gets to draw each round
- ⏱️ Configurable turn duration (30–180 seconds) with hint reveals at 40% and 70%
- 🎯 "Almost!" indicator when guesses are within 2 characters of the word

**Room Management**
- 🚪 Create/join rooms with 6-character codes (click to copy)
- 👑 Host controls: kick players, configure settings, start game
- ✅ Ready check system in lobby
- 👋 Leave room voluntarily

**Resilience**
- 🔌 Auto-reconnect on page refresh (120-second grace window)
- ⏳ 20-second countdown before ending game on disconnect (with "End Now" option for host)
- 🏠 Host reassignment on disconnect

**Social**
- 😂 Emoji reactions (👍 😂 🔥 ❤️ 👏 😮)
- 💬 Lobby chat before game starts
- 🏅 Final leaderboard with rematch option

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, FastAPI, uvicorn, asyncio |
| Frontend | React 18, TypeScript, Vite, React Router v6 |
| Communication | WebSocket (JSON protocol) |
| Testing | pytest + Hypothesis (backend), Vitest + Testing Library (frontend) |
| Deployment | Docker, Azure Container Apps |
| IaC | Terraform (optional) |

## Architecture

```
Browser (React SPA)          Server (FastAPI)
┌─────────────────┐         ┌──────────────────────┐
│  WebSocketContext│◄──WS──►│  ws_handler.py        │
│  gameReducer     │         │  ├── room_manager.py  │
│  useCanvas hook  │         │  ├── game_engine.py   │
│  Pages/Components│         │  ├── heartbeat.py     │
└─────────────────┘         │  └── models.py        │
                             └──────────────────────┘
```

- All game state lives in-memory on the server (single process)
- Frontend is a thin rendering layer — server enforces all rules
- O(1) player lookups via `players_by_id` dict and `_player_to_room` index
- Guess ordering tracked via insertion-order list (no sorting at turn end)

## Quick Start

### Prerequisites
- Python 3.12+
- Node.js 18+

### Run Locally

```bash
# Backend
pip install fastapi uvicorn websockets
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
# Backend (212 tests — unit + property-based + integration)
python -m pytest backend/tests/ -v

# Frontend (62 tests — component + reducer)
cd frontend && npx vitest run

# Performance test (simulates concurrent WebSocket clients)
python scripts/perf_test.py --clients 100
```

### Performance Results (100 clients)

| Metric | Value |
|--------|-------|
| Connection establishment | 5.7ms avg |
| Room creation RTT | 1.0ms avg |
| Stroke broadcast latency | 1.1ms avg (P95: 1.85ms) |
| Concurrent connections | 500/500 established |
| Message throughput | 6,781 msgs/sec |

## Deployment (Azure)

See [deploy-azure.md](deploy-azure.md) for full instructions.

```bash
# Quick deploy with Docker + Azure CLI
az login
docker build -t skribblacr.azurecr.io/skribbl-app:latest .
docker push skribblacr.azurecr.io/skribbl-app:latest
az containerapp create --name skribbl-app ...
```

Terraform config also available in `infra/main.tf`.

## Project Structure

```
skribbl-app/
├── backend/
│   ├── main.py              # FastAPI app + WebSocket route
│   ├── ws_handler.py        # Message dispatch + connection lifecycle
│   ├── room_manager.py      # Room CRUD, player management, kick/leave
│   ├── game_engine.py       # Turn logic, scoring, hints, close-guess
│   ├── models.py            # Dataclasses (Player, Room, TurnState)
│   ├── heartbeat.py         # Ping/pong connection health
│   ├── words.py             # 200+ word list
│   └── tests/               # 212 tests (unit + property + integration)
├── frontend/
│   ├── src/
│   │   ├── context/         # WebSocketContext + gameReducer
│   │   ├── pages/           # Landing, Lobby, Game, GameOver
│   │   ├── components/      # Canvas, Chat, PlayerList, TimerBar
│   │   ├── hooks/           # useCanvas, useWebSocket
│   │   └── types/           # TypeScript interfaces
│   └── __tests__/           # 62 component + reducer tests
├── scripts/
│   └── perf_test.py         # WebSocket performance benchmark
├── infra/
│   └── main.tf             # Terraform (Azure Container Apps)
├── Dockerfile               # Multi-stage build
├── deploy-azure.md          # Deployment guide
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
| `start_game` | Host starts game |
| `select_word` | Drawer picks word |
| `stroke` | Drawing data (real-time) |
| `guess` | Submit a guess |
| `chat` | Send chat message |
| `reaction` | Emoji reaction |
| `toggle_ready` | Ready status |
| `kick_player` | Host kicks player |
| `leave_room` | Leave voluntarily |
| `rematch` | Start new game |

## License

MIT
