# Requirements Document

## Introduction

Replace the per-player WebSocket connection between the Go gateway and Python workers with gRPC bidirectional streaming. Currently each player connection results in a dedicated backend WebSocket (5000 players = 5000 backend connections). With gRPC multiplexing, the gateway opens one gRPC stream per room to the owning worker. Players sharing a room share a single backend connection, reducing backend connections from ~5000 to ~1000 (one per room) and eliminating the ~500 connections-per-worker Python event loop bottleneck. The client-facing WebSocket JSON protocol remains unchanged.

## Glossary

- **Gateway**: The Go WebSocket proxy server (port 9000) that accepts client connections and routes messages to Python workers
- **Worker**: A Python FastAPI process running game logic (game_engine.py, room_manager.py) that owns room state
- **Room_Stream**: A single gRPC bidirectional streaming connection between the Gateway and a Worker, carrying multiplexed messages for all players in one room
- **Stream_Manager**: The Gateway component responsible for creating, caching, and recycling Room_Stream instances (one per room)
- **gRPC_Server**: The Python server-side gRPC endpoint exposed by each Worker alongside the existing WebSocket handler
- **Proto_Definition**: The Protocol Buffer (.proto) file defining message types and service RPCs for gateway-worker communication
- **Envelope**: A gRPC message wrapper that includes player_id, room_code, and the original JSON payload for multiplexing multiple players over a single stream
- **Fan_Out**: The process where the Gateway receives a broadcast from a Worker over a Room_Stream and delivers it to all relevant client WebSocket connections
- **WorkerResolver**: The existing Gateway component that resolves worker IDs to network addresses via Redis
- **Fallback_Mode**: The backward-compatible operating mode where the Gateway uses per-player WebSocket proxying when gRPC is unavailable
- **Virtual_Transport**: A Python adapter class that implements a `send_text(data)` interface but routes messages through the Room_Stream gRPC channel instead of a real WebSocket — allows existing broadcast/game logic to work without modification
- **grpc.aio**: The asyncio-native gRPC Python implementation that runs on the same event loop as FastAPI/uvicorn, avoiding thread-pool conflicts

## Requirements

### Requirement 1: Protocol Buffer Definition

**User Story:** As a developer, I want a shared Protocol Buffer definition for gateway-worker communication, so that both Go and Python components use a strongly-typed, versioned wire format.

#### Acceptance Criteria

1. THE Proto_Definition SHALL define a `GameService` with a bidirectional streaming RPC named `RoomStream` that accepts a stream of `GameMessage` and returns a stream of `GameMessage`
2. THE Proto_Definition SHALL define a `GameMessage` message type containing fields for player_id (string), room_code (string), message_type (string), and payload (bytes containing the original JSON)
3. THE Proto_Definition SHALL define a `BroadcastMessage` message type containing fields for room_code (string), message_type (string), payload (bytes), and target_player_ids (repeated string, empty means all players in room)
4. THE Proto_Definition SHALL compile without errors using protoc for both Go (grpc-go plugin) and Python (grpcio-tools)
5. WHEN the Proto_Definition is compiled, THE generated Go code SHALL be placed in a `proto/` package within the gateway directory
6. WHEN the Proto_Definition is compiled, THE generated Python code SHALL be placed in a `backend/proto/` package within the backend directory

### Requirement 2: gRPC Server on Python Workers

**User Story:** As a system operator, I want each Python worker to expose a gRPC server, so that the gateway can communicate over multiplexed streams instead of per-player WebSockets.

#### Acceptance Criteria

1. WHEN a Worker starts, THE gRPC_Server SHALL listen on a configurable port (default 50051) using `grpc.aio` (asyncio-native gRPC) alongside the existing FastAPI WebSocket server on port 8000
2. WHEN the gRPC_Server receives a `GameMessage` on a `RoomStream`, THE gRPC_Server SHALL extract the player_id, room_code, and JSON payload and dispatch the message through the existing room_manager and game_engine logic
3. WHEN a player is connected via gRPC multiplexing, THE Worker SHALL create a virtual transport adapter for that player that implements a `send_text(data)` interface, routing messages back through the Room_Stream as targeted BroadcastMessages instead of a real WebSocket. THE Virtual_Transport's `send_text` SHALL be an awaitable that serializes writes to the shared Room_Stream using a per-stream asyncio.Lock or write queue to prevent interleaved frames.
4. WHEN the game logic calls `broadcast()` for a room, THE broadcast function SHALL detect gRPC-connected players (those with a virtual transport) and route their messages through the Room_Stream rather than attempting WebSocket sends
5. WHEN the game logic produces a targeted message for a specific player, THE gRPC_Server SHALL send a `BroadcastMessage` with the target_player_ids field populated with that player's ID
6. THE gRPC_Server SHALL register its gRPC port in Redis under the key `worker_grpc_addresses` using the same worker ID used for WebSocket registration
7. IF the gRPC_Server fails to bind its port at startup, THEN THE Worker SHALL log the error and continue operating in WebSocket-only mode

### Requirement 3: Gateway Stream Manager

**User Story:** As a system operator, I want the gateway to manage one gRPC stream per room, so that multiple players in the same room share a single backend connection.

#### Acceptance Criteria

1. WHEN the first player in a room connects to the Gateway, THE Stream_Manager SHALL open a new Room_Stream to the Worker owning that room
2. WHILE a Room_Stream is open, THE Stream_Manager SHALL reuse it for all subsequent players joining the same room
3. WHEN the last player in a room disconnects from the Gateway, THE Stream_Manager SHALL close the Room_Stream after a configurable idle timeout (default 30 seconds)
4. THE Stream_Manager SHALL maintain a map of room_code to active Room_Stream, providing O(1) lookup for message routing
5. IF a Room_Stream encounters a transport error, THEN THE Stream_Manager SHALL mark the stream as unhealthy, evict it from the cache, and attempt to re-establish a new stream on the next message for that room
6. THE Stream_Manager SHALL resolve Worker addresses using the existing WorkerResolver, querying the `worker_grpc_addresses` Redis hash for gRPC-specific endpoints

### Requirement 4: Message Multiplexing (Client to Worker)

**User Story:** As a player, I want my game messages delivered to the correct room on the backend, so that game interactions work seamlessly regardless of the transport layer.

#### Acceptance Criteria

1. WHEN the Gateway receives a WebSocket message from a client, THE Gateway SHALL wrap it in an Envelope containing the player_id, room_code, and original JSON payload before sending over the Room_Stream
2. WHEN the Gateway receives a `create_room` message from a client, THE Gateway SHALL open a new Room_Stream to the least-loaded Worker, send the Envelope, wait for the `room_created` response to extract the room_code, and then register the stream in the Stream_Manager under that room_code. WHILE the stream registration is pending, THE Gateway SHALL hold a creation lock on the stream so that concurrent `join_room` requests for the same (not-yet-known) room_code fall through to Redis lookup (which will not yet return a result until the Worker registers ownership).
3. WHEN the Gateway receives a `join_room` message from a client, THE Gateway SHALL send the Envelope over the existing Room_Stream for that room_code
4. THE Gateway SHALL preserve message ordering per player: messages from the same client SHALL arrive at the Worker in the order they were sent
5. THE Gateway SHALL NOT require strict ordering between messages from different players on the same Room_Stream (head-of-line blocking between players is acceptable at the stream level since the Worker processes messages sequentially per room anyway)
6. IF no Room_Stream exists for a room_code and the Worker address cannot be resolved, THEN THE Gateway SHALL return an error message to the client WebSocket with code "NO_BACKEND"

### Requirement 5: Broadcast Fan-Out (Worker to Clients)

**User Story:** As a player, I want to receive game broadcasts with low latency, so that the game feels responsive.

#### Acceptance Criteria

1. WHEN the Gateway receives a `BroadcastMessage` with an empty target_player_ids field from a Room_Stream, THE Gateway SHALL deliver the payload to all client WebSocket connections associated with that room_code
2. WHEN the Gateway receives a `BroadcastMessage` with a populated target_player_ids field, THE Gateway SHALL deliver the payload only to the client WebSocket connections matching those player IDs
3. THE Gateway SHALL maintain a mapping of room_code to a set of (player_id, WebSocket connection) pairs for O(1) fan-out lookup
4. WHEN a client disconnects, THE Gateway SHALL remove the player's entry from the fan-out mapping and send a disconnect notification Envelope over the Room_Stream to the Worker
5. THE Gateway SHALL deliver broadcast messages to clients within 10ms of receiving them from the Room_Stream, measured from receipt to first byte queued to each client's outbound buffer (excluding TCP-level backpressure). THE Gateway SHALL use a non-blocking per-connection outbound queue to avoid one slow client delaying delivery to others.

### Requirement 6: Backward-Compatible Fallback

**User Story:** As a system operator, I want the gateway to fall back to per-player WebSocket proxying when gRPC is unavailable, so that the system remains operational during partial upgrades or gRPC failures.

#### Acceptance Criteria

1. WHEN the Gateway cannot find a gRPC address for a Worker in `worker_grpc_addresses`, THE Gateway SHALL fall back to the existing per-player WebSocket proxy behavior using the `worker_addresses` hash
2. WHEN a Room_Stream fails and cannot be re-established after 3 retry attempts with exponential backoff (1s, 2s, 4s), THE Gateway SHALL fall back to WebSocket proxy mode for all players in that room
3. WHILE operating in Fallback_Mode for a room, THE Gateway SHALL continue serving that room via per-player WebSocket connections until the room is empty or gRPC becomes available again
4. THE Gateway SHALL expose a health endpoint field `grpc_enabled` (boolean) indicating whether gRPC connectivity is operational
5. THE Gateway SHALL log a warning when entering Fallback_Mode including the room_code and the reason for fallback

### Requirement 7: Player Session Tracking on Gateway

**User Story:** As a developer, I want the gateway to track which players belong to which rooms, so that it can correctly multiplex and demultiplex messages.

#### Acceptance Criteria

1. WHEN a client sends a `create_room` or `join_room` message and the Worker responds with success, THE Gateway SHALL store the association of (player_id, room_code, WebSocket connection) in its session registry
2. WHEN a client sends a `reconnect` message and the Worker responds with success, THE Gateway SHALL update the session registry with the new WebSocket connection for the existing player_id and re-associate it with the existing Room_Stream for that room
3. WHEN a client sends a `reconnect` message, THE Worker SHALL update the player's virtual transport adapter to route messages back through the active Room_Stream (marking the player as connected again)
4. WHEN a client WebSocket connection closes, THE Gateway SHALL remove the player from the session registry and notify the Worker via the Room_Stream
5. THE Gateway SHALL reject messages from a client that has not completed the create_room, join_room, or reconnect handshake by responding with an error code "NOT_IDENTIFIED"
6. THE Gateway session registry SHALL support concurrent access from multiple goroutines without data races

### Requirement 8: Redis Service Discovery for gRPC

**User Story:** As a system operator, I want workers to register their gRPC endpoints in Redis, so that the gateway can discover and connect to them dynamically.

#### Acceptance Criteria

1. WHEN a Worker starts with gRPC enabled, THE Worker SHALL register its gRPC address in the Redis hash `worker_grpc_addresses` using its worker_id as the field name and `hostname:grpc_port` as the value
2. WHILE a Worker is running with gRPC enabled, THE Worker SHALL refresh a liveness key `worker_grpc_alive:{worker_id}` with a 30-second TTL every 10 seconds
3. WHEN a Worker shuts down gracefully, THE Worker SHALL remove its entry from `worker_grpc_addresses` and delete its `worker_grpc_alive` key
4. THE Gateway SHALL check `worker_grpc_alive:{worker_id}` before opening a new Room_Stream to confirm the Worker's gRPC server is reachable
5. IF the `worker_grpc_alive` key does not exist for a Worker, THEN THE Gateway SHALL skip gRPC and use WebSocket fallback for connections to that Worker

### Requirement 9: Performance at Scale

**User Story:** As a system operator, I want the system to handle 10,000 concurrent users on 8 Python workers, so that we achieve the Phase 2 scaling target without adding more worker instances.

#### Acceptance Criteria

1. THE Gateway SHALL sustain 10,000 concurrent client WebSocket connections with 100% connection success rate
2. THE system SHALL achieve end-to-end message latency (client send → worker process → client receive) of less than 50ms at the 95th percentile under 10,000 concurrent users
3. THE system SHALL maintain a game completion rate above 80% under 10,000 concurrent virtual users
4. WHILE serving 10,000 concurrent users, THE total number of Room_Streams across all Workers SHALL remain below 1,500 (approximately one per room)
5. WHILE serving 10,000 concurrent users, THE per-Worker connection count (Room_Streams) SHALL remain below 200

### Requirement 10: Graceful Stream Lifecycle

**User Story:** As a player, I want my game session to survive temporary network issues between gateway and worker, so that brief infrastructure blips do not disrupt my game.

#### Acceptance Criteria

1. WHEN a Room_Stream disconnects unexpectedly, THE Stream_Manager SHALL attempt reconnection with exponential backoff (1s, 2s, 4s) up to 3 times before entering Fallback_Mode
2. WHILE reconnecting a Room_Stream, THE Gateway SHALL buffer up to 500 outbound messages per room and deliver them upon successful reconnection (500 messages provides ~7 seconds of buffering at peak drawing rate of ~70 msgs/sec per room, covering the full 7-second retry window)
3. IF the message buffer overflows (exceeds 500 messages), THEN THE Gateway SHALL drop the oldest messages and log a warning with the room_code and number of dropped messages
4. WHEN a Room_Stream is successfully re-established, THE Gateway SHALL replay buffered messages in order and resume normal multiplexed operation
5. THE Gateway SHALL send a keepalive ping over each Room_Stream every 15 seconds and consider the stream dead if no response is received within 5 seconds

### Requirement 11: Proto Compilation and Build Integration

**User Story:** As a developer, I want proto compilation integrated into the build process, so that generated code stays in sync with the proto definition.

#### Acceptance Criteria

1. THE Proto_Definition SHALL be stored at `proto/game.proto` in the repository root
2. THE build system SHALL provide a Makefile target `proto-gen` that compiles game.proto and outputs Go code to `gateway/proto/` and Python code to `backend/proto/`
3. WHEN `make proto-gen` is executed, THE build system SHALL generate valid Go and Python gRPC stubs without manual intervention
4. THE generated code SHALL be committed to the repository so that builds do not require protoc to be installed
5. THE Proto_Definition SHALL use proto3 syntax and the package name `skribbl.gateway.v1`
6. THE Proto_Definition SHALL evolve using backward-compatible field additions only (no removing or renumbering existing fields) to ensure Go gateway and Python workers can be deployed at different proto versions during rolling upgrades


### Requirement 12: gRPC Stream Observability

**User Story:** As a system operator, I want visibility into gRPC stream health and multiplexing efficiency, so that I can diagnose performance issues and validate scaling assumptions.

#### Acceptance Criteria

1. THE Gateway SHALL expose a gauge metric `grpc_streams_active` counting the number of currently open Room_Streams
2. THE Gateway SHALL expose a counter metric `grpc_stream_errors_total` counting stream failures by error type (transport_error, timeout, buffer_overflow)
3. THE Gateway SHALL expose a histogram metric `grpc_messages_per_stream` tracking how many messages are multiplexed per stream per minute
4. THE Gateway SHALL expose a counter metric `grpc_fallback_activations_total` counting how many times Fallback_Mode was activated
5. THE Worker SHALL expose a gauge metric `grpc_streams_serving` counting the number of active Room_Streams being served by this worker
6. ALL gRPC metrics SHALL be available on the Gateway's `/metrics` endpoint in Prometheus exposition format for time-series collection, and a summary SHALL also be included in the `/health` JSON response for operational dashboards
