# Architecture

## System Overview

Skribbl is a real-time multiplayer drawing game built on a high-throughput, **Three-Tier Distributed Architecture**:

1. **Frontend Client Tier**: React 18 SPA (TypeScript, Vite) — thin rendering layer with synchronous drawing canvas, zero client-side game logic, and Web Audio API synthesizer.
2. **Edge Gateway Tier**: Go 1.22 Edge Gateways — high-concurrency WebSocket termination using an epoll event loop, connection pooling, client heartbeats, and frame backpressure.
3. **Application Worker Tier**: Python 3.12 + FastAPI Game Workers — authoritative in-memory game state, turn lifecycle state machines, stroke validation, Levenshtein distance matching, and gRPC servicer streams.
4. **State & Synchronization Tier**: Redis 7 — Append-Only File (AOF) persistence, room registry, active worker discovery, and cross-gateway pub/sub relay.

---

## High-Level Architecture

```
                          Internet (Browser Clients & k6)
                                         │
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │          Nginx Reverse Proxy / LB              │
                 │          (Public Subnet, Port 80/443)          │
                 │   hash "$arg_gw$arg_room$arg_cid" consistent   │
                 └───────────────┬────────────────┬───────────────┘
                                 │                │
                 ┌───────────────▼┐              ┌▼───────────────┐
                 │ Go Gateway 1   │              │ Go Gateway N   │
                 │ (EC2, :9000)   │  ...         │ (EC2, :9000)   │
                 │ + Coord :9100  │              │ + Coord :9100  │
                 └───────┬────────┘              └────────┬───────┘
                         │                                │
                         │  gRPC RoomStream (:50051)      │
                         └───────────────┬────────────────┘
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │           Python Worker Tier                   │
                 │   Worker 1 (:50051) ... Worker M (:50051)      │
                 │   (FastAPI + gRPC Servicer + VirtualTransport) │
                 └───────────────────────┬────────────────────────┘
                                         │
                                         ▼
                 ┌────────────────────────────────────────────────┐
                 │          Redis Tier (:6379)                    │
                 │   Dedicated EC2 Instance with AOF persistence  │
                 │   (Room registry, worker discovery, snapshots) │
                 └────────────────────────────────────────────────┘
```

---

## Edge Gateway Tier (`gateway/`)

The edge gateway offloads all connection-heavy I/O from the Python event loop, allowing the cluster to scale past 150,000+ concurrent Virtual Users (VUs):

### 1. Epoll Event Loop & WebSocket Termination (`:9000`)
- Built in Go 1.22 using Gorilla WebSocket and low-overhead epoll socket pooling.
- Handles connection upgrades, TLS termination, ping/pong heartbeats, and client disconnect detection.
- Buffers and chunks binary drawing frames to eliminate head-of-line blocking.

### 2. gRPC RoomStream Client (`:50051`)
- Maintains persistent, bidirectional gRPC streaming connections (`RoomStream`) to Python workers.
- Uses Protobuf binary serialization (`proto/roomstream.proto`) for minimal wire latency and CPU overhead.
- Relays client actions to the authoritative worker and pushes worker state updates back to clients.

### 3. Inter-Gateway Coordinator (`:9100`)
- Synchronizes room-to-gateway routing tables and cluster metrics.
- Exposes health probes and Prometheus/OpenTelemetry instrumentation.

---

## Application Worker Tier (`backend/`)

Python workers host the authoritative game logic and in-memory room state:

### `grpc_server.py` — gRPC RoomStream Servicer
Implements the `RoomStreamService` servicer. Receives incoming message streams from Go gateways, wraps them in a `VirtualTransport` abstraction, and dispatches them directly into `RoomManager` and `GameEngine` without HTTP/WebSocket overhead.

### `ws_handler.py` — WebSocket Lifecycle (Direct / Local Mode)
Direct entrypoint for single-container development and local testing. Accepts the WebSocket, launches heartbeat tasks, and dispatches JSON messages to `RoomManager` or `GameEngine`.

### `room_manager.py` — Room Lifecycle & Player Management
Owns the in-memory registry of all active rooms with $O(1)$ lookups via `_rooms` and `_player_to_room`:
- **Room lifecycle**: Creation, password verification, deletion, and cleanup.
- **Player management**: Add, remove, kick, ready toggle, avatar customization.
- **Spectator mode**: Direct spectator entry, host approval queue for mid-game joins, and role promotion requests (max 2 attempts per game).
- **Disconnection/reconnection**: 120-second grace window with scheduled cancellation tasks.
- **Broadcasting**: Sends messages to all room participants (or relays via Redis when multi-worker).

### `game_engine.py` — Game State Machine
Enforces all core game rules and turn progressions:
- **Turn lifecycle**: Word selection (15s) → active drawing → turn end → next turn.
- **Scoring**: Quadratic decay formula with position multipliers (1.5×, 1.2×, 1.0×, 0.9×) and drawer bonus.
- **Streak tracking**: Increments on consecutive correct guesses; resets on missed turns.
- **Close guess detection**: Levenshtein distance $\le 2$ on words $\ge 3$ characters triggers a private "very close" notification without revealing the answer.
- **Hint reveals**: Automated reveals at 40% and 70% elapsed time.
- **MVP awards**: Speed Demon, Sniper, Streak Master, and Master Artist computed at game over.

### `words.py` — Curated Word Packs & Themes
Provides categorized thematic packs (Animals, Food & Drink, Fantasy, Pop Culture, Everyday Objects) and supports host-injected custom words.

### `redis_pubsub.py` — Worker Discovery & Cross-Node Sync
Provides Redis integration when `REDIS_URL` is set:
- Registers active worker heartbeat entries.
- Publishes and subscribes to room channels to synchronize state when players in the same room connect across different nodes.

### `models.py` — Data Models
Type-safe dataclasses defining the domain models:
- `Player`: ID, display name, score, avatar, connection state, streak, spectator flag, request count.
- `Room`: Code, host ID, players, password, theme, game state, config.
- `GameConfig`: Rounds, turn duration, max players, custom words.
- `TurnState`: Active drawer, word, hint characters, timestamps, guess ordering.
- `VoteKickState`: Target ID, voter records, expiration timer.
- `SpectatorRoleRequest`: Joiner ID, requested role, timestamp.

---

## Data Flow

### 1. High-Performance Distributed Path (Production AWS)
```
Browser ──WS──► Nginx (consistent hash) ──► Go Gateway (epoll)
                                                │
                                    gRPC RoomStream (:50051)
                                                │
                                                ▼
                                        Python Game Worker
                                        (VirtualTransport → GameEngine)
                                                │
                                                ▼
                                         Redis 7 (:6379)
                                   (State Sync & Discovery)
```

### 2. Single-Worker Direct Path (Development / Local)
```
Browser ──WS──► FastAPI (ws_handler.py) ──► RoomManager ──► broadcast ──► Browser
                                               └──► GameEngine
```

---

## Deployment Topologies

### 1. Single Container (Development / Low Concurrency)
- FastAPI serves both the built React frontend (`frontend/dist/`) and the WebSocket API.
- Suitable for local development and up to 500 concurrent connections.

### 2. Local Multi-Worker (Docker Compose)
- Nginx load balancer with sticky session cookies (`worker_id`).
- 3 Python app workers + Redis pub/sub relay.
- Suitable for 500–2,000 concurrent players.

### 3. AWS Multi-Host Distributed Cluster (Terraform)
- **Nginx Reverse Proxy / Load Balancer** (`c5a.4xlarge`) on public subnet.
- **Go Edge Gateways** (`c5a.2xlarge`) terminating WebSockets via epoll.
- **Python Game Workers** (`c5a.2xlarge`) hosting authoritative room engines.
- **Dedicated Redis Node** (`c5a.xlarge`) with AOF persistence.
- Verified capacity: **150,000+ concurrent VUs**, 512M messages, 4.00 Gbps line rate, 0 control drops.

---

## Key Design Principles

1. **Server Authoritative**: All game rules, scores, hints, and timers are computed strictly on the backend. The frontend never computes game outcomes.
2. **In-Memory Hot Path**: Active game rooms live purely in RAM for sub-millisecond turn updates and stroke broadcasts.
3. **Decoupled Edge Termination**: Separating high-concurrency WebSocket I/O (Go) from game domain logic (Python) protects game tick rates from connection floods and network storms.
4. **Resilient Reconnections**: 120-second grace periods and sticky session cookies ensure seamless mobile browser refreshes and momentary network drop recoveries.
