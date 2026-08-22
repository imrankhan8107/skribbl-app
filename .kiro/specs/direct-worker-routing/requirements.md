# Requirements Document

## Introduction

This document specifies the requirements for Direct Worker Routing — a feature that eliminates nginx from the WebSocket path by having the Go WebSocket gateway resolve individual Python worker container addresses from Redis and connect directly over Docker's internal network. The goal is to achieve 5000 concurrent WebSocket connections at 100% success rate with sub-500ms latency, replacing the current nginx-proxied path that suffers from 8–16 second dial times and 48% connection failure under load.

## Glossary

- **Gateway**: The Go WebSocket gateway service that accepts client connections on port 9000 and proxies them to backend workers
- **Worker**: A Python FastAPI backend container running on port 8000 that hosts game rooms and player state
- **Worker_Registry**: The Redis hash `worker_addresses` that maps worker IDs to their reachable hostname:port addresses
- **Liveness_Key**: The Redis key `worker_alive:{worker_id}` with 30-second TTL that indicates a worker is healthy
- **Worker_Resolver**: The Go component that resolves worker IDs to network addresses using a local cache backed by Redis
- **Address_Cache**: The in-memory cache in the Gateway that stores resolved worker addresses for 5 seconds to avoid per-connection Redis lookups
- **Fallback_Router**: The Gateway logic that routes to an alternative worker when the primary target is unreachable
- **Room_Owner**: The worker that created and holds the authoritative state for a specific game room
- **Heartbeat**: The periodic signal (every 10 seconds) a Worker sends to Redis to refresh its liveness key and address registration
- **Docker_Network**: The shared bridge network enabling container-to-container communication via hostname

## Requirements

### Requirement 1: Worker Address Registration

**User Story:** As a system operator, I want workers to register their reachable network addresses in Redis on startup, so that the gateway can discover and connect to them directly.

#### Acceptance Criteria

1. WHEN a Worker starts up, THE Worker SHALL register its address as `{HOSTNAME}:{port}` in the Worker_Registry hash within 10 seconds of process start
2. WHEN a Worker registers its address, THE Worker SHALL set the Liveness_Key with a 30-second TTL
3. WHILE a Worker is running, THE Worker SHALL refresh the Liveness_Key and Worker_Registry entry every 10 seconds via Heartbeat
4. WHEN a Worker receives a SIGTERM signal, THE Worker SHALL remove its entry from the Worker_Registry and delete its Liveness_Key before process exit
5. IF the Redis connection is unavailable during registration, THEN THE Worker SHALL continue operating in single-worker mode without registration

### Requirement 2: Address Resolution and Caching

**User Story:** As a gateway operator, I want the gateway to resolve worker addresses from Redis with local caching, so that connection routing is fast and does not overload Redis.

#### Acceptance Criteria

1. WHEN the Worker_Resolver receives a resolution request for a worker ID, THE Worker_Resolver SHALL check the Address_Cache before querying Redis
2. WHILE an Address_Cache entry is younger than 5 seconds, THE Worker_Resolver SHALL return the cached address without a Redis lookup
3. WHEN an Address_Cache entry is older than 5 seconds, THE Worker_Resolver SHALL fetch the address from the Worker_Registry in Redis
4. WHEN a Redis lookup returns a valid address, THE Worker_Resolver SHALL store the result in the Address_Cache with the current timestamp
5. IF a worker ID is not found in the Worker_Registry, THEN THE Worker_Resolver SHALL return an error indicating the worker is not registered
6. IF Redis is unreachable during resolution, THEN THE Worker_Resolver SHALL return an error to the caller

### Requirement 3: Direct WebSocket Connection

**User Story:** As a player, I want my WebSocket connection routed directly to the correct worker container, so that room creation and joining complete within 500ms instead of 8+ seconds.

#### Acceptance Criteria

1. WHEN a client sends a `create_room` message, THE Gateway SHALL route the connection to the least-loaded worker as determined by the `worker_load` sorted set
2. WHEN a client sends a `join_room` message with a room code, THE Gateway SHALL route the connection to the Room_Owner worker registered for that room code
3. WHEN the Gateway establishes a backend connection, THE Gateway SHALL dial the worker directly at `ws://{resolved_address}/ws` without routing through nginx
4. WHEN a direct dial succeeds, THE Gateway SHALL establish a bidirectional WebSocket pipe between the client and the worker
5. THE Gateway SHALL complete the dial to a healthy worker in less than 100 milliseconds

### Requirement 4: Fallback Routing on Worker Failure

**User Story:** As a player, I want my connection attempt to succeed even if the target worker is down, so that transient failures do not block me from playing.

#### Acceptance Criteria

1. WHEN a dial attempt to the primary worker fails, THE Fallback_Router SHALL evict that worker from the Address_Cache and attempt connection to the next least-loaded worker
2. WHEN the Worker_Resolver determines a worker's Liveness_Key does not exist, THE Fallback_Router SHALL skip that worker and select an alternative
3. THE Fallback_Router SHALL attempt a maximum of 2 dial attempts total (primary plus one fallback) before returning an error to the client
4. IF all dial attempts fail, THEN THE Gateway SHALL return a `BACKEND_UNAVAILABLE` error to the client
5. WHEN a dial failure occurs, THE Gateway SHALL log the failure with the worker ID and resolved address for operational visibility

### Requirement 5: Worker Liveness Detection

**User Story:** As a system operator, I want the gateway to detect dead workers within 30 seconds, so that connections are not routed to crashed containers.

#### Acceptance Criteria

1. WHEN a Worker has not refreshed its Liveness_Key within 30 seconds, THE Liveness_Key SHALL expire via Redis TTL
2. WHEN the Gateway checks liveness for a worker whose Liveness_Key has expired, THE Gateway SHALL remove that worker's entry from the Worker_Registry and the worker_load sorted set
3. WHEN a worker is detected as dead, THE Worker_Resolver SHALL evict the worker from the Address_Cache
4. WHILE a Worker is alive and running, THE Heartbeat SHALL ensure the Liveness_Key never expires by refreshing it every 10 seconds

### Requirement 6: Docker Network Configuration

**User Story:** As a system operator, I want all services on a shared Docker network, so that the gateway can reach workers by container hostname without exposing worker ports to the host.

#### Acceptance Criteria

1. THE Gateway and all Worker containers SHALL be placed on the same Docker bridge network
2. THE Gateway SHALL reach Worker containers using their Docker-assigned hostnames on port 8000
3. THE Worker containers SHALL expose port 8000 only internally within the Docker network, not to the host
4. THE Gateway SHALL expose port 9000 to the host as the only externally accessible WebSocket endpoint
5. THE nginx service SHALL serve only static frontend assets and SHALL NOT proxy WebSocket traffic to workers

### Requirement 7: Load Reporting with Address Refresh

**User Story:** As a system operator, I want the periodic load reporter to also refresh address registration, so that a single heartbeat cycle maintains both load metrics and service discovery.

#### Acceptance Criteria

1. WHEN the Worker reports its load to the `worker_load` sorted set, THE Worker SHALL also refresh its entry in the Worker_Registry and its Liveness_Key in the same heartbeat cycle
2. THE Worker SHALL report the current connection count as its load score in the `worker_load` sorted set
3. WHEN the Worker reports load, THE Worker SHALL set an expiry of 120 seconds on the `worker_load` sorted set entry
4. IF Redis is unavailable during load reporting, THEN THE Worker SHALL skip the report and retry on the next heartbeat cycle

### Requirement 8: Performance Targets

**User Story:** As a system operator, I want the direct routing system to handle 5000 concurrent connections with 100% success rate, so that the platform can scale without connection failures.

#### Acceptance Criteria

1. THE Gateway SHALL support 5000 concurrent WebSocket connections with a 100% connection success rate
2. THE Gateway SHALL achieve room create and join latency below 500 milliseconds at the 95th percentile
3. THE Gateway SHALL achieve a dial time to any healthy worker below 100 milliseconds
4. THE Address_Cache SHALL add no more than 2 megabytes of memory overhead for up to 12 cached worker entries
5. THE Worker_Resolver SHALL generate no more than 1000 Redis HGET operations per second at 5000 concurrent connections due to the 5-second cache TTL

### Requirement 9: Graceful Degradation on Redis Failure

**User Story:** As a system operator, I want the gateway to fall back to round-robin routing when Redis is unavailable, so that temporary Redis outages do not cause total service failure.

#### Acceptance Criteria

1. IF Redis is unreachable during address resolution, THEN THE Gateway SHALL fall back to round-robin routing among the statically configured backend addresses
2. WHILE Redis is unavailable, THE Gateway SHALL continue serving connections using the fallback backend list
3. WHEN Redis becomes available again, THE Gateway SHALL resume normal Redis-based address resolution for new connections
4. WHILE Address_Cache entries remain valid (within 5-second TTL), THE Gateway SHALL continue using cached addresses even during a Redis outage

