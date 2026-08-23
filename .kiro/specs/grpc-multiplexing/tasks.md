# Implementation Plan: gRPC Multiplexing

## Overview

Replace per-player WebSocket connections between the Go gateway and Python workers with gRPC bidirectional streaming at the room level. Implementation proceeds from protocol definition → server/client components → integration → testing, with Python (backend) and Go (gateway) as the implementation languages.

## Tasks

- [x] 1. Protocol Buffer Definition and Build Integration
  - [x] 1.1 Create proto/game.proto with GameService, GameMessage, and BroadcastMessage
    - Define `GameService` with bidirectional streaming RPC `RoomStream`
    - Define `GameMessage` with fields: player_id (string), room_code (string), message_type (string), payload (bytes)
    - Define `BroadcastMessage` with fields: room_code (string), message_type (string), payload (bytes), target_player_ids (repeated string)
    - Use proto3 syntax, package `skribbl.gateway.v1`, go_package `gateway/proto`
    - _Requirements: 1.1, 1.2, 1.3, 11.1, 11.5_

  - [x] 1.2 Create Makefile target `proto-gen` for Go and Python code generation
    - Add `proto-gen` target that compiles game.proto to `gateway/proto/` (Go) and `backend/proto/` (Python)
    - Ensure generated `__init__.py` for Python package
    - Commit generated code so builds don't require protoc installed
    - _Requirements: 11.2, 11.3, 11.4, 1.4, 1.5, 1.6_

- [x] 2. Python gRPC Server and Virtual Transport
  - [x] 2.1 Implement Virtual Transport adapter (`backend/virtual_transport.py`)
    - Create `VirtualTransport` class with `send_text(data)` and `send_json(data)` methods
    - Route messages through a per-stream `asyncio.Queue` as `BroadcastMessage` with correct `target_player_ids`
    - Ensure `send_text` is awaitable and serializes writes to prevent interleaved frames
    - _Requirements: 2.3, 2.5_

  - [ ]* 2.2 Write property test for VirtualTransport output (Property 3)
    - **Property 3: VirtualTransport Produces Correct BroadcastMessage**
    - Generate random (player_id, room_code, data) tuples, assert BroadcastMessage fields match
    - Test file: `backend/tests/test_property_grpc_transport.py`
    - **Validates: Requirements 2.3, 2.5**

  - [x] 2.3 Implement gRPC server (`backend/grpc_server.py`)
    - Create `GameServiceServicer` class implementing `RoomStream` bidirectional streaming RPC
    - Extract player_id, room_code, payload from `GameMessage` and dispatch through room_manager/game_engine
    - Manage `VirtualTransport` instances per gRPC-connected player
    - Use `asyncio.Queue` per stream for outbound `BroadcastMessage` serialization
    - Integrate with existing `grpc.aio` on the same asyncio event loop as FastAPI
    - Handle graceful shutdown: clean up virtual transports on stream context cancellation
    - _Requirements: 2.1, 2.2, 2.4, 2.7_

  - [ ]* 2.4 Write property test for message dispatch correctness (Property 2)
    - **Property 2: Message Dispatch Correctness**
    - Generate message_types from known set + random payloads, verify handler routing matches WebSocket handler
    - Test file: `backend/tests/test_property_grpc_dispatch.py`
    - **Validates: Requirements 2.2**

  - [ ]* 2.5 Write property test for proto serialization round-trip (Property 1)
    - **Property 1: Proto Serialization Round-Trip**
    - Generate random GameMessage and BroadcastMessage instances, serialize to wire format, deserialize back, assert equality
    - Test file: `backend/tests/test_property_grpc_proto.py`
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 2.6 Write property test for broadcast routing (Property 4)
    - **Property 4: Broadcast Routes to Correct Transport Type**
    - Generate rooms with mixed WS/gRPC players, verify broadcast delivers to correct transport with no duplicates or misses
    - Test file: `backend/tests/test_property_grpc_broadcast.py`
    - **Validates: Requirements 2.4**

- [x] 3. Checkpoint - Backend gRPC components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Redis Service Discovery for gRPC
  - [x] 4.1 Implement worker gRPC registration in Redis
    - On startup with gRPC enabled, register gRPC address in `worker_grpc_addresses` hash (worker_id → hostname:port)
    - Refresh `worker_grpc_alive:{worker_id}` key with 30s TTL every 10 seconds
    - On graceful shutdown, remove entry from `worker_grpc_addresses` and delete alive key
    - If gRPC port bind fails, log error and skip registration (WebSocket-only mode)
    - _Requirements: 8.1, 8.2, 8.3, 2.6, 2.7_

- [x] 5. Gateway Session Registry (`gateway/session.go`)
  - [x] 5.1 Implement thread-safe session registry
    - Create `SessionRegistry` struct with `sync.RWMutex` protection
    - Implement `Register(playerID, roomCode, conn)`, `Unregister(playerID)`, `Update(playerID, conn)` methods
    - Implement `GetByRoom(roomCode)` and `GetByPlayer(playerID)` lookup methods
    - Maintain dual-index: `sessions` (player_id → session) and `byRoom` (room_code → {player_id → session})
    - Use `PlayerSession` struct with per-connection `SendCh` (non-blocking outbound queue)
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.6_

  - [ ]* 5.2 Write property test for session registry correctness (Property 9)
    - **Property 9: Session Registry Correctness**
    - Generate register/reconnect sequences, verify state consistency after each operation
    - Test file: `gateway/session_test.go`
    - **Validates: Requirements 7.1, 7.2**

  - [ ]* 5.3 Write property test for unidentified client rejection (Property 10)
    - **Property 10: Unidentified Client Rejection**
    - Generate messages without prior handshake, verify NOT_IDENTIFIED error response
    - Test file: `gateway/session_test.go`
    - **Validates: Requirements 7.5**

  - [ ]* 5.4 Write property test for concurrent session registry safety (Property 11)
    - **Property 11: Concurrent Session Registry Safety**
    - Run concurrent Register/Unregister/Update/Lookup operations with Go race detector, verify no data races
    - Test file: `gateway/session_test.go` (run with `-race`)
    - **Validates: Requirements 7.6**

- [x] 6. Gateway Stream Manager (`gateway/stream_manager.go`)
  - [x] 6.1 Implement Stream Manager with room-to-stream mapping
    - Create `StreamManager` struct with `map[string]*RoomStream` (room_code → stream)
    - Implement `GetOrCreate(roomCode, workerID)` for lazy stream creation
    - Implement `Send(roomCode, msg)` for routing GameMessages to the correct stream
    - Implement `AddPlayer(roomCode)` / `RemovePlayer(roomCode)` for player count tracking
    - Implement `Close(roomCode)` with configurable idle timeout (default 30s)
    - Resolve worker addresses via `WorkerResolver` using `worker_grpc_addresses` Redis hash
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 6.2 Implement Message Buffer for reconnection (`gateway/buffer.go`)
    - Create `MessageBuffer` struct with FIFO queue, max size 500
    - Buffer messages during stream reconnection
    - Drop oldest messages on overflow, log warning with room_code and drop count
    - Replay buffered messages in order on successful reconnection
    - _Requirements: 10.2, 10.3, 10.4_

  - [ ]* 6.3 Write property test for stream reuse (Property 5)
    - **Property 5: Stream Reuse Per Room (Multiplexing Invariant)**
    - Generate N join sequences for same room, assert stream count remains exactly 1
    - Test file: `gateway/stream_manager_test.go`
    - **Validates: Requirements 3.2, 9.4**

  - [ ]* 6.4 Write property test for per-player message ordering (Property 6)
    - **Property 6: Per-Player Message Ordering**
    - Generate ordered message sequences from single player, verify arrival order preserved
    - Test file: `gateway/stream_manager_test.go`
    - **Validates: Requirements 4.4**

  - [ ]* 6.5 Write property test for message buffer FIFO (Property 12)
    - **Property 12: Message Buffer FIFO with Overflow**
    - Generate sequences of 0–1000 messages, verify retention/order rules (≤500 kept, newest retained, FIFO replay)
    - Test file: `gateway/buffer_test.go`
    - **Validates: Requirements 10.2, 10.3, 10.4**

- [x] 7. Fan-Out Dispatcher (`gateway/fanout.go`)
  - [x] 7.1 Implement Fan-Out Dispatcher
    - Create `FanOutDispatcher` struct with reference to `SessionRegistry`
    - Implement `Deliver(msg *BroadcastMessage)`: if target_player_ids empty → broadcast to all in room; otherwise → targeted delivery
    - Use non-blocking enqueue to per-connection `SendCh` to avoid slow-client head-of-line blocking
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [ ]* 7.2 Write property test for fan-out delivery targets (Property 7)
    - **Property 7: Fan-Out Delivery Targets**
    - Generate BroadcastMessages with empty/populated target lists, verify correct delivery set
    - Test file: `gateway/fanout_test.go`
    - **Validates: Requirements 5.1, 5.2**

- [x] 8. Checkpoint - Gateway core components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Fallback Handler and Stream Lifecycle
  - [x] 9.1 Implement backward-compatible fallback handler
    - Create `handleWithFallback` function: attempt gRPC path first, fall back to existing per-player WS proxy
    - Check `worker_grpc_alive:{worker_id}` before attempting gRPC connection
    - Implement retry logic: 3 attempts with exponential backoff (1s, 2s, 4s) before entering Fallback_Mode
    - Log warnings on fallback activation with room_code and reason
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 8.4, 8.5_

  - [x] 9.2 Implement graceful stream lifecycle (keepalive, reconnection, buffering)
    - Send keepalive ping every 15 seconds per Room_Stream
    - Mark stream dead if no pong received within 5 seconds
    - On unexpected disconnect: buffer messages, attempt reconnection, replay buffer on success
    - Transition to Fallback_Mode if 3 retries exhausted
    - _Requirements: 10.1, 10.2, 10.4, 10.5_

  - [ ]* 9.3 Write property test for fallback mode decision (Property 8)
    - **Property 8: Fallback Mode Decision**
    - Generate worker states (±gRPC alive key, ±address entry), verify correct mode selection
    - Test file: `gateway/fallback_test.go`
    - **Validates: Requirements 6.1, 8.5**

- [x] 10. Message Multiplexing and Client Integration
  - [x] 10.1 Implement client-to-worker envelope wrapping in gateway
    - On WebSocket message from client: wrap in `GameMessage` with player_id, room_code, JSON payload
    - For `create_room`: open new Room_Stream to least-loaded worker, hold creation lock, register stream after receiving room_code
    - For `join_room`: send envelope over existing Room_Stream for that room_code
    - For unknown room_code without resolvable worker: return error "NO_BACKEND"
    - Preserve per-player message ordering within the stream
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 10.2 Implement broadcast reception and fan-out in gateway
    - Receive `BroadcastMessage` from Room_Stream recv loop
    - Pass to `FanOutDispatcher.Deliver()` for client delivery
    - Handle client disconnect: remove from session registry, notify worker via Room_Stream
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 10.3 Wire gateway health endpoint with `grpc_enabled` field
    - Add `grpc_enabled` boolean to existing `/health` endpoint JSON response
    - Reflect actual gRPC connectivity status
    - _Requirements: 6.4_

- [x] 11. gRPC Stream Observability
  - [x] 11.1 Implement Prometheus metrics for gRPC streams in gateway
    - Register `grpc_streams_active` gauge
    - Register `grpc_stream_errors_total` counter with `error_type` label (transport_error, timeout, buffer_overflow)
    - Register `grpc_messages_per_stream` histogram
    - Register `grpc_fallback_activations_total` counter
    - Expose all metrics on `/metrics` endpoint and summary in `/health` JSON
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.6_

  - [x] 11.2 Implement worker-side gRPC metrics
    - Register `grpc_streams_serving` gauge on Python worker
    - Increment/decrement on stream open/close
    - Expose via existing metrics endpoint
    - _Requirements: 12.5_

- [x] 12. Checkpoint - Full system integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Integration Tests
  - [x] 13.1 Write end-to-end room lifecycle integration test
    - Test create_room → join_room → play → game_over via gRPC path
    - Verify messages flow correctly through the full multiplexed path
    - _Requirements: 2.2, 4.1, 5.1_

  - [x] 13.2 Write reconnection and fallback integration tests
    - Test player reconnect mid-game: verify buffered state delivery
    - Test fallback activation: simulate gRPC port failure, verify seamless WS proxy takeover
    - Test worker registration/shutdown: verify Redis entries created and cleaned up
    - _Requirements: 6.2, 7.2, 7.3, 8.1, 8.3, 10.1, 10.4_

  - [x] 13.3 Write keepalive and stream lifecycle integration test
    - Test keepalive timeout: delay pong, verify stream marked dead and reconnection triggered
    - Test buffer overflow: send >500 messages during reconnection, verify oldest dropped
    - _Requirements: 10.3, 10.5_

- [x] 14. Performance Benchmarks
  - [x] 14.1 Create k6 load test script for 10K concurrent users
    - Script with 10K VUs maintaining WebSocket connections
    - Measure connection success rate (target: 100%)
    - Measure p95 end-to-end latency (target: <50ms)
    - Measure game completion rate (target: >80%)
    - Verify stream count stays below 1,500 total and <200 per worker
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 15. Final checkpoint - All tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Python property tests use Hypothesis (already in project); Go property tests use `rapid`
- Proto-generated code is committed so CI builds don't require protoc installed

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "5.1", "4.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "5.2", "5.3", "5.4"] },
    { "id": 4, "tasks": ["2.4", "2.5", "2.6", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "6.4", "7.1"] },
    { "id": 6, "tasks": ["6.5", "7.2"] },
    { "id": 7, "tasks": ["9.1", "9.2", "10.1"] },
    { "id": 8, "tasks": ["9.3", "10.2", "10.3"] },
    { "id": 9, "tasks": ["11.1", "11.2"] },
    { "id": 10, "tasks": ["13.1", "13.2", "13.3"] },
    { "id": 11, "tasks": ["14.1"] }
  ]
}
```
