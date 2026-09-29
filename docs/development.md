# Development Guide

## Prerequisites

- **Python**: 3.12+
- **Node.js**: 18+ (Node 20 recommended)
- **Go**: 1.22+ (for building and running the Edge Gateway)
- **Git**
- **Protoc** (Protocol Buffers compiler, optional for modifying `.proto` files)

---

## Local Setup

### 1. Backend (Python + FastAPI)

```bash
# Install Python dependencies
pip install -r requirements.txt

# Run the FastAPI server (direct WebSocket mode on :8000)
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

To run the Python gRPC worker independently:
```bash
python -m backend.grpc_server --port 50051
```

### 2. Edge Gateway (Go)

```bash
cd gateway
go mod download

# Run edge gateway on :9000 with coordinator on :9100
go run cmd/gateway/main.go --port 9000 --coord 9100 --worker localhost:50051
```

### 3. Frontend (React 18 + Vite)

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server runs at `http://localhost:5173` and proxies `/ws` requests to `localhost:8000` (or `localhost:9000` when targeting the Go Gateway).

### Access

- **Development UI**: `http://localhost:5173` (Vite dev server with HMR)
- **Direct FastAPI Container**: `http://localhost:8000` (FastAPI serving static frontend)
- **Nginx Multi-Worker Gateway**: `http://localhost:8080` (when using Docker Compose)

---

## Testing

### Backend Tests (330 tests)

```bash
# Run all backend tests
python -m pytest backend/tests/ -v

# Run specific test file
python -m pytest backend/tests/test_scoring.py -v

# Run property-based tests with higher coverage
HYPOTHESIS_MAX_EXAMPLES=500 python -m pytest backend/tests/ -v

# Run only property tests
python -m pytest backend/tests/test_property_*.py -v

# Run gRPC and transport integration tests
python -m pytest backend/tests/test_grpc_server.py backend/tests/test_ws_integration.py -v
```

**Test categories:**
| Category | Key Files | Description |
|----------|-----------|-------------|
| Unit | `test_scoring.py`, `test_hints.py`, `test_word_selection.py` | Pure logic and scoring functions |
| Property-based | `test_property_*.py` (15 files) | Hypothesis invariant tests |
| Lifecycle | `test_turn_lifecycle.py`, `test_disconnection.py`, `test_rematch.py` | Turn transitions & disconnect handling |
| Role & Moderation | `test_spectator_promotion.py`, `test_vote_kick.py`, `test_anti_spam.py` | Spectator promotion, anti-spam, vote kick |
| Integration & gRPC | `test_ws_integration.py`, `test_grpc_server.py` | Full client-server and gRPC streaming suites |

### Frontend Tests (151 tests)

```bash
cd frontend

# Run all tests (single pass)
npx vitest run

# Watch mode
npx vitest

# Run with verbose output
npx vitest run --reporter=verbose
```

**Test categories:**
| File | Tests | Description |
|------|-------|-------------|
| `gameReducer.test.ts` | 24 | Pure reducer state transitions & new role actions |
| `Landing.test.tsx` | 14 | Form submission, password validation, spectator toggle |
| `Lobby.test.tsx` | 18 | Settings presets, host transfer, custom word builder |
| `Game.test.tsx` | 26 | Turn timer, theme badges, spectator promotion banner |
| `Canvas.test.tsx` | 20 | Smoothing, stroke/shape tools, undo/redo stack |
| `Chat.test.tsx` | 16 | Close guess notification, typing indicators, mute |
| `PlayerList.test.tsx` | 15 | Streaks, vote-kick modal, role indicators |
| `GameOver.test.tsx` | 18 | MVP badges, rematch flow, exportable scorecard |

### Go Gateway Tests

```bash
cd gateway

# Run all gateway tests
go test ./... -v

# Run with race detector
go test -race ./...
```

### Performance & Load Testing

#### 1. Local WebSocket Benchmarks
```bash
# Single-worker connection and message rate benchmark
python scripts/perf_test.py --clients 100

# Multi-worker sticky session verification test
python scripts/perf_test_sticky.py --host localhost --port 8080 --clients 10 --p95-max 50
```

#### 2. Distributed k6 gRPC Load Tests (Scale Milestones)
```bash
# Smoke test (validate connection lifecycle & message correctness)
k6 run scripts/k6_grpc_smoke_test.js

# High-concurrency load test (ramps to target VUs)
k6 run --vus 5000 --duration 5m scripts/k6_grpc_load_test.js
```

#### 3. Real-Time Cluster Monitor
```bash
# Monitors /proc CPU, memory, socket buffers, and network interfaces every 1s
python scripts/cluster_monitor.py --interval 1
```

---

## Pre-commit Hooks

The `.husky/pre-commit` hook automatically detects which layers changed and executes only the relevant test and lint gates:

### Frontend Changes Detected
1. **Prettier** — format validation on staged `.ts`, `.tsx`, and `.css` files.
2. **TypeScript** — strict `tsc --noEmit` type checking.
3. **Build** — `npm run build` production bundling.
4. **Tests** — Vitest executed on changed files.

### Backend Changes Detected
- Source code changes trigger the full `pytest` suite.
- Isolated test file changes run only the edited test files.

---

## Protocol Buffers Code Generation

If you modify `proto/roomstream.proto`, regenerate both the Python and Go stubs:

```bash
# Generate Go code
protoc --go_out=. --go-grpc_out=. proto/roomstream.proto

# Generate Python code
python -m grpc_tools.protoc -I. --python_out=backend --grpc_python_out=backend proto/roomstream.proto
```

---

## Project Conventions

### Backend
- **Python 3.12**: Strict type hinting (`str | None`, modern match statements).
- **Dataclasses**: Used for all domain entities without heavy ORM overhead.
- **asyncio**: Used for all I/O, timers, and Redis pub/sub tasks.
- **Error Handling**: Handlers gracefully catch and format error messages without terminating connections.

### Frontend
- **TypeScript strict mode**: Zero `any` types; all message payloads strongly typed.
- **Functional Components**: React hooks exclusively (`useCanvas`, `useWebSocket`, `useReducer`).
- **Synchronous Event Bus**: Low-latency rendering streams via `drawingBus.ts` and `reactionBus.ts`.

### Edge Gateway
- **Go 1.22**: Idiomatic concurrency using goroutines and channels with epoll event pooling.
- **Backpressure**: Non-blocking channel write patterns with queue buffers to prevent slow consumers from exhausting memory.
