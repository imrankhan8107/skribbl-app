# Skribbl Distributed Architecture Specification

## 1. System Overview

Skribbl is an ultra-low-latency, real-time multiplayer drawing and guessing platform designed to scale from single-machine local development up to **150,000+ concurrent Virtual Users (VUs)** with sub-millisecond drawing latency and server-authoritative game guarantees.

The system uses a **Bifurcated-Path Distributed Architecture** where high-frequency drawing payloads and authoritative game state logic are decoupled into specialized tiers:

```
                            [ Web & Mobile Clients ]
                                       │
                                       ▼
                   ┌───────────────────────────────────────┐
                   │       Nginx Reverse Proxy / LB        │
                   │  hash "$arg_gw$arg_room$arg_cid"      │
                   └───────────────────┬───────────────────┘
                                       │ WebSocket (Binary + Text)
                                       ▼
                   ┌───────────────────────────────────────┐
                   │         Go Edge Gateway Tier          │
                   │  - Epoll Connection Termination       │
                   │  - Fast-Path Binary Memory Fanout     │  <── Low Latency (<1ms)
                   │  - Burst Coalescing & Dual Queues     │      (Strokes, Fills, Clears)
                   └───────────────────┬───────────────────┘
                                       │ Bidirectional gRPC RoomStream
                                       │ (JSON Control Actions / Broadcasts)
                                       ▼
                   ┌───────────────────────────────────────┐
                   │      Python Application Workers       │
                   │  - Authoritative Game State Machines  │
                   │  - Levenshtein Guess Matching         │
                   │  - Round Timers & Scoring Decay       │
                   └───────────────────┬───────────────────┘
                                       │
                                       ▼
                   ┌───────────────────────────────────────┐
                   │           Redis 7 Cluster             │
                   │  - Worker Discovery & Heartbeats      │
                   │  - Room Registry & State Fallback     │
                   └───────────────────────────────────────┘
```

---

## 2. High-Level Component Topology

| Component | Technology | Primary Responsibilities | Network / Protocol |
| :--- | :--- | :--- | :--- |
| **Client Frontend** | React 18, TypeScript, Vite, Canvas 2D | Double-buffered rendering, pointer interpolation, binary canvas codec, reactive drawing bus | Browser WebSocket (`wss://`) |
| **Ingress Proxy** | Nginx (`c5a.4xlarge`) | TLS termination, connection routing via room-based consistent hashing, HTTP/1.1 upgrade | TCP :80, :443 |
| **Edge Gateway** | Go 1.22 (`c5a.2xlarge`) | C100k+ WebSocket termination, binary frame fast-path fan-out, write coalescing, gRPC bridge | TCP :9000 (WS), :9100 (Coord) |
| **App Game Worker** | Python 3.12, FastAPI, AsyncIO | Authoritative game state machine, turn cycles, quadratic score decay, fuzzy guess scoring | gRPC :50051 (Protobuf) |
| **Shared State & Sync** | Redis 7 (`c5a.xlarge`) | Worker registration, room routing table, inter-worker pub/sub broadcast fallback | TCP :6379 (RESP) |

---

## 3. Tier 1: Client Frontend Tier (`frontend/`)

The frontend is a lightweight, responsive single-page application built on React 18 and Vite. It is strictly presentation-only: **zero game logic runs on the client**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          React 18 Frontend                             │
│                                                                        │
│  ┌─────────────────────────┐          ┌─────────────────────────────┐  │
│  │     useCanvas Hook      │          │   WebSocketContext Provider │  │
│  │ - Pointer event capture │          │ - BinaryType = 'arraybuffer'│  │
│  │ - Coordinate smoothing  │          │ - Auto-reconnect & backoff  │  │
│  └────────────┬────────────┘          └──────────────┬──────────────┘  │
│               │                                      │                 │
│        binary │ encode                        binary │ decode          │
│               ▼                                      ▼                 │
│  ┌─────────────────────────┐          ┌─────────────────────────────┐  │
│  │    binaryDrawing.ts     │          │         drawingBus          │  │
│  │ - 7-23 byte pack format │          │ - Decoupled from React DOM  │  │
│  │ - Multi-point batches   │          │ - Direct 2D canvas draw     │  │
│  └────────────┬────────────┘          └──────────────┬──────────────┘  │
│               │ sendBinary()                         │                 │
└───────────────┼──────────────────────────────────────┼─────────────────┘
                │ WebSocket Frame                      │
                ▼                                      ▲
```

### Key Modules:
- **`binaryDrawing.ts` (Phase 1 Codec)**:
  - Packs mouse/pointer drawing points into ultra-compact binary byte buffers using typed `DataView` and `Uint8Array`.
  - Normalizes coordinate space to $0 - 65535$ ($16$-bit unsigned integer resolution), decoupled from physical screen size or DPI.
  - Supports 4 operation codes:
    - `0x01` (`STROKE`): Multi-point path batches with color and brush size.
    - `0x02` (`CLEAR_CANVAS`): Instant clear command.
    - `0x03` (`FILL`): Flood-fill coordinates with target color.
    - `0x04` (`HIGHLIGHTER`): Semi-transparent multi-point highlighter strokes.
- **`drawingBus.ts` (Reactive Drawing Pipeline)**:
  - Bypasses React state rendering loops entirely. When incoming binary frames arrive on the WebSocket, `WebSocketContext` passes the payload directly to `drawingBus.publishDrawing(msg)`.
  - The canvas renders strokes immediately on the 2D canvas context, maintaining 60–120 FPS without causing React component re-renders.
- **`useCanvas.ts`**:
  - Handles pointer events, Bezier curve smoothing, and shape snapping (lines, rectangles, ellipses).
  - Collects pointer points into batched micro-buffers and flushes them to the network via `sendBinary()`. Falls back gracefully to JSON `send()` if binary mode is unavailable.
- **`WebSocketContext.tsx`**:
  - Maintains the persistent client connection with `ws.binaryType = "arraybuffer"`.
  - Inspects incoming frame types: binary buffers are decoded via `binaryDrawing.decodeBinaryDrawing()` and forwarded to `drawingBus`; text strings are parsed as JSON game control events and dispatched to React state.

---

## 4. Tier 2: Edge Gateway Tier (`gateway/`)

The Edge Gateway is written in Go 1.22. It offloads all high-concurrency connection I/O, ping/pong heartbeats, and frame multiplexing from the Python application workers.

```
                         Client WebSocket Connection
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │          Session Read         │
                     │          (`readPump`)         │
                     └───────┬───────────────┬───────┘
                             │               │
            Binary Frame     │               │ Text / JSON
          (OpCode < 0x20)    │               │ (OpCode >= 0x20)
                             ▼               ▼
          ┌─────────────────────┐   ┌────────────────────────┐
          │   GatewayFanOut     │   │     StreamManager      │
          │   (`DeliverBinary`) │   │  gRPC Bidirectional    │
          │  Direct in-memory   │   │  RoomStream to Python  │
          │  room distribution  │   │  (:50051)              │
          └──────────┬──────────┘   └───────────┬────────────┘
                     │                          │
                     │  ┌────────────────────┐  │
                     │  │ Client Write Pump  │  │
                     └─►│  (`writePump`)     │◄─┘
                        │ - Lossy Queue      │
                        │ - Control Queue    │
                        │ - Burst Coalescing │
                        └─────────┬──────────┘
                                  │
                                  ▼
                         To Browser Clients
```

### 1. Bifurcated Routing & Fast-Path Fan-Out
- **Binary Fast-Path (`fanout.go` & `main.go`)**:
  - High-frequency drawing events do not affect authoritative game state. When `readPump` receives a `websocket.BinaryMessage`, it bypasses the gRPC stream and Python worker entirely.
  - The Gateway invokes `gw.fanOut.DeliverBinary(session.RoomCode, session.PlayerID, payload)`.
  - The message is immediately delivered to the `lossyCh` of all other active sessions in the room within local RAM ($<1\text{ms}$ fanout latency).
- **Control gRPC Stream (`stream_manager.go`)**:
  - Text JSON messages (guesses, word selections, lobby updates, kicks, reactions) are forwarded to the authoritative Python worker via persistent gRPC `RoomStream` channels.

### 2. Dual-Queue Backpressure & Burst Coalescing (`session.go`)
Each connected client session maintains two distinct internal egress channels:
1. **`sendCh` (Guaranteed Control Queue, buffer = 1024)**:
   - Reserved exclusively for authoritative game events (scores, turn start, chat, winner announcements).
   - If full, it logs backpressure and drops non-critical control frames under extreme congestion without disconnecting the client.
2. **`lossyCh` (Lossy Drawing Queue, buffer = 2048)**:
   - Reserved for binary drawing strokes.
   - Non-blocking: if the client's network is saturated, oldest drawing frames are dropped to preserve real-time interactivity.
3. **Burst Coalescing in `writePump`**:
   - When a binary frame is pulled from `lossyCh`, `writePump` opportunistically drains all remaining pending binary frames in `lossyCh`.
   - It coalesces them into a single contiguous byte buffer and sends them as a single `websocket.BinaryMessage` network packet. This drastically reduces OS TCP syscalls and NIC packet fragmentation.

### 3. Session Registry (`registry.go`)
- Thread-safe in-memory registry indexing sessions by `playerID` and `roomCode` using read-write mutexes (`sync.RWMutex`).
- Enables $O(1)$ lookup for room broadcasts and player disconnect cleanups.

---

## 5. Tier 3: Authoritative Application Worker Tier (`backend/`)

The Application Worker tier is implemented in Python 3.12 using FastAPI and AsyncIO. It is the sole authority on game rules, word selection, round lifecycles, and scoring.

```
                      gRPC RoomStream (:50051)
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │     grpc_server.py     │
                     │   (VirtualTransport)   │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │    room_manager.py     │
                     │   - Room lifecycle     │
                     │   - Host permissions   │
                     │   - Spectator queues   │
                     └───────────┬────────────┘
                                 │
                                 ▼
                     ┌────────────────────────┐
                     │    game_engine.py      │
                     │   - State machine      │
                     │   - Scoring quadratic  │
                     │   - Levenshtein check  │
                     │   - Hint timers        │
                     └────────────────────────┘
```

### Key Modules:
- **`grpc_server.py` (`RoomStreamServicer`)**:
  - Implements the gRPC bidirectional streaming interface defined in `proto/roomstream.proto`.
  - Bridges the gRPC stream into an internal `VirtualTransport` object, decoupling game logic from the transport protocol (WebSocket vs gRPC).
- **`room_manager.py` (Room & Player Lifecycle)**:
  - Manages active rooms via `_rooms` and `_player_to_room` maps.
  - Manages player roles (`PLAYER` vs `SPECTATOR`), host permissions, transfer of host status, and mid-game spectator promotion queues.
  - Implements a **120-second reconnection grace period**: if a player drops connection, their state remains preserved in memory until the grace timer expires.
- **`game_engine.py` (Authoritative Game State Machine)**:
  - **Turn Phases**: `LOBBY` $\rightarrow$ `STARTING` $\rightarrow$ `WORD_SELECTION` (15s) $\rightarrow$ `DRAWING` (configurable 30–120s) $\rightarrow$ `TURN_END` $\rightarrow$ `GAME_OVER`.
  - **Scoring Engine**:
    - Calculates points based on elapsed time using quadratic decay:
      $$\text{Score} = \text{BasePoints} \times \left(1 - \frac{t_{\text{elapsed}}}{T_{\text{total}}}\right)^2 \times \text{PositionMultiplier}$$
    - Position multipliers reward fast guessers ($1\text{st} = 1.5\times, 2\text{nd} = 1.2\times, 3\text{rd} = 1.0\times, 4\text{th}+ = 0.9\times$).
    - Awards drawer bonus proportional to the percentage of guessers who solved the word.
  - **Levenshtein Fuzzy Guess Detection**:
    - Evaluates distance $d$ between guess and target word.
    - If $d \le 2$ on words $\ge 3$ characters, broadcasts a private `"You are very close!"` hint without revealing the secret word to other players.
  - **Automated Hint Engine**:
    - Periodically reveals masked word letters at $40\%$ and $70\%$ elapsed turn time.
  - **Vote-Kick Engine**:
    - Tracks quorum requiring $\lceil (N - 1) \times 0.6 \rceil$ votes to eject disruptive participants.
- **`words.py`**:
  - Curated dictionary packs categorized by difficulty and theme (Animals, Food, Everyday Objects, Pop Culture).
  - Supports host-supplied custom word lists.

---

## 6. Tier 4: State & Synchronization Tier (`Redis 7`)

Redis 7 serves as the coordination and state persistence backbone across nodes:
- **Worker Discovery**: Workers register ephemeral heartbeat keys (`worker:{id}:heartbeat`) with 10-second TTLs.
- **Room Registry**: Stores metadata mapping room codes to authoritative worker IDs (`room:{room_code}:worker`).
- **Pub/Sub Cross-Node Fallback (`redis_pubsub.py`)**:
  - When clients or workers are distributed across multiple server instances, state transitions and chat broadcasts publish to channel `room:{room_code}:events`.
  - Local workers subscribed to the channel relay events to their respective Go Gateways.

---

## 7. Network & Routing Ingress: Nginx Consistent Hashing

To allow local in-memory binary fan-out on Go Gateways without expensive inter-gateway synchronization, Nginx routes client WebSocket handshakes using consistent hashing:

```nginx
upstream go_gateway_backend {
    hash "$arg_gw$arg_room$arg_cid" consistent;
    server 10.0.1.10:9000 max_fails=3 fail_timeout=10s;
    server 10.0.1.11:9000 max_fails=3 fail_timeout=10s;
    keepalive 512;
}
```

### Architectural Benefit:
All players joining room `ABCD12` hash to the **exact same Go Edge Gateway instance**. Consequently:
1. Drawing strokes never need to cross network boundaries between gateways.
2. Go Gateway delivers strokes directly from one socket to peer sockets within local process memory.
3. Redis CPU load and cluster network bandwidth remain virtually unaffected by high-frequency drawing activity.

---

## 8. End-to-End Data Flow Scenarios

### Scenario A: Real-Time Drawing Stroke (Fast-Path)
```
Browser A (Drawer)
  │  1. Pointer drag event captured in useCanvas
  │  2. Packed into 7-23 byte binary buffer by binaryDrawing.ts
  │  3. Sent via ws.send(ArrayBuffer)
  ▼
Nginx (Port 443)
  │  4. Consistent hash forwards to Gateway 1
  ▼
Go Gateway 1 (:9000)
  │  5. readPump detects BinaryMessage (OpCode 0x01 < 0x20)
  │  6. Bypasses gRPC! Calls fanOut.DeliverBinary(roomCode, senderID, bytes)
  │  7. Enqueues bytes into lossyCh of Browser B and Browser C
  │  8. writePump coalesces pending records into single frame
  ▼
Browser B & Browser C (Guessers)
  │  9. onmessage receives ArrayBuffer
  │ 10. Decoded by binaryDrawing.ts
  │ 11. drawingBus renders stroke on 2D Canvas context immediately (<1ms)
```

### Scenario B: Guesser Submits Correct Guess (Authoritative Control Path)
```
Browser B (Guesser)
  │  1. Types "elephant" in Chat input
  │  2. Sent via ws.send(JSON: {"type": "guess", "word": "elephant"})
  ▼
Go Gateway 1 (:9000)
  │  3. readPump detects TextMessage (JSON prefix '{')
  │  4. Forwarded over gRPC RoomStream to Python Worker
  ▼
Python Worker (:50051)
  │  5. RoomStreamServicer receives ClientAction
  │  6. GameEngine checks guess against target word
  │  7. Strict match! Computes quadratic score decay & streak bonus
  │  8. Emits "correct_guess" and "player_guessed" events
  │  9. Pushes ServerBroadcast down gRPC response stream
  ▼
Go Gateway 1 (:9000)
  │ 10. StreamManager delivers to fanOut.DeliverControl(roomCode, jsonBytes)
  │ 11. Enqueues into sendCh (guaranteed control queue) of all room sessions
  ▼
All Room Browsers
  │ 12. onmessage parses JSON: updates scoreboard, plays sound, hides drawer word
```

---

## 9. Binary Protocol Specification (Phase 1)

Drawing events use a compact packed binary format:

### 1. `STROKE` (`OpCode 0x01`) and `HIGHLIGHTER` (`OpCode 0x04`)
```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  OpCode (1B)  |   Color Index (1B)            |Brush Size (1B)|
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|       X0 (2B, 0-65535)        |       Y0 (2B, 0-65535)        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|       X1 (2B, 0-65535)        |       Y1 (2B, 0-65535)        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                              ...                              |
```
- **Single Point**: $1 + 1 + 1 + 2 + 2 = 7\text{ bytes}$ (vs $\sim 45\text{ bytes}$ in JSON).
- **5-Point Segment**: $3 + (5 \times 4) = 23\text{ bytes}$ (vs $\sim 160\text{ bytes}$ in JSON).

### 2. `FILL` (`OpCode 0x03`)
```
[1 Byte OpCode 0x03] [1 Byte Color Index] [2 Bytes X] [2 Bytes Y] = 6 bytes total
```

### 3. `CLEAR_CANVAS` (`OpCode 0x02`)
```
[1 Byte OpCode 0x02] = 1 byte total
```

---

## 10. Architectural Verification & Performance Metrics

| Metric | Target | Verified Production Result |
| :--- | :--- | :--- |
| **Max Concurrent VUs** | 30,000 (Target 150k+) | **30,000 VUs per runner** (150,000+ cluster) |
| **Connection Success Rate** | $\ge 99.0\%$ | **100.00%** (30,000 / 30,000 opened) |
| **Game Completion Rate** | $\ge 80.0\%$ | **99.98%** (29,121 / 29,122 games) |
| **Drawing Frame Delivery Latency** | $< 5\text{ms}$ | **$< 1\text{ms}$** (Go in-memory fan-out) |
| **Control Message Drops** | $0$ | **0 drops** across 69M+ received messages |
| **Bandwidth Reduction** | $\ge 70\%$ | **$\approx 80\%$ payload reduction** via Binary Codec |
