# 🎯 Topic 37: WebSocket & Real-Time at Scale

> **System Design Interview — Deep Dive**
> A comprehensive guide covering WebSocket gateway architecture, connection management at 10M+ concurrent users, presence (online/offline), cross-gateway messaging, heartbeat mechanisms, graceful degradation (SSE, long polling), and how to articulate real-time system design with depth and precision in an interview.

---

## Table of Contents

1. [Core Concept](#core-concept)
2. [WebSocket vs HTTP vs SSE vs Long Polling](#websocket-vs-http-vs-sse-vs-long-polling)
3. [WebSocket Gateway Architecture](#websocket-gateway-architecture)
4. [Connection Management at Scale](#connection-management-at-scale)
5. [Cross-Gateway Messaging](#cross-gateway-messaging)
6. [Presence System (Online / Offline / Last Seen)](#presence-system-online--offline--last-seen)
7. [Heartbeat & Connection Health](#heartbeat--connection-health)
8. [Message Delivery Flow](#message-delivery-flow)
9. [Scaling to Millions of Connections](#scaling-to-millions-of-connections)
10. [Graceful Degradation](#graceful-degradation)
11. [Real-World System Examples](#real-world-system-examples)
12. [Deep Dive: Applying Real-Time to Popular Problems](#deep-dive-applying-real-time-to-popular-problems)
13. [Interview Talking Points & Scripts](#interview-talking-points--scripts)
14. [Common Interview Mistakes](#common-interview-mistakes)
15. [Summary Cheat Sheet](#summary-cheat-sheet)

---

## Core Concept

**Real-time communication** means delivering data to clients within milliseconds of it being produced — without the client having to ask for it. WebSockets provide a persistent, full-duplex connection between client and server, enabling the server to **push** data to the client instantly.

```
HTTP (Request-Response):
  Client: "Any new messages?" → Server: "No" (wasted round-trip)
  Client: "Any new messages?" → Server: "No" (wasted round-trip)
  Client: "Any new messages?" → Server: "Yes! Here's 1 message" (latency: polling interval)
  
  Average latency: polling_interval / 2 (e.g., 5 seconds if polling every 10 seconds)
  Wasted requests: 99% of polls return empty (massive server load)

WebSocket (Persistent Connection):
  Client ←──────────────────→ Server (persistent TCP connection)
  Server: "New message!" → Client receives instantly
  
  Latency: ~30ms (network round-trip only)
  Wasted requests: Zero (server pushes only when there's data)
```

---

## WebSocket vs HTTP vs SSE vs Long Polling

### Comparison

| Aspect | WebSocket | Server-Sent Events (SSE) | Long Polling | HTTP Polling |
|---|---|---|---|---|
| **Direction** | Full-duplex (both ways) | Server → Client only | Server → Client (with tricks) | Client → Server → Response |
| **Connection** | Persistent TCP | Persistent HTTP | Repeated HTTP | Repeated HTTP |
| **Latency** | ~30ms | ~30ms | 100-500ms | Polling interval / 2 |
| **Overhead per message** | 2-6 bytes (frame header) | ~50 bytes (HTTP headers) | ~500 bytes (full HTTP) | ~500 bytes (full HTTP) |
| **Max connections/server** | ~65K (file descriptor limit) | ~65K | Limited by threads | N/A (stateless) |
| **Browser support** | All modern browsers | All modern (except IE) | All browsers | All browsers |
| **Proxy/firewall friendly** | Sometimes problematic | Yes (HTTP-based) | Yes | Yes |
| **Auto-reconnect** | Manual (client-side) | Built-in | Built-in (client retries) | N/A |
| **Best for** | Chat, gaming, collaboration | Live feeds, dashboards | Fallback for WebSocket | Simple updates, low frequency |

### When to Use Each

```
WebSocket:
  ✅ Bidirectional communication (chat, multiplayer gaming)
  ✅ High-frequency updates (stock prices, live sports)
  ✅ Lowest latency required (< 50ms)
  ✅ Both client and server send data frequently

SSE (Server-Sent Events):
  ✅ Server-to-client streaming only (live feeds, notifications)
  ✅ Simple implementation (built on HTTP)
  ✅ Auto-reconnect built into browser API
  ✅ Works through proxies/firewalls without issues

Long Polling:
  ✅ Fallback when WebSocket/SSE not available
  ✅ Works through all proxies and firewalls
  ✅ Simpler server-side implementation

HTTP Polling:
  ✅ Updates needed infrequently (every 30-60 seconds)
  ✅ Simplest implementation
  ✅ Stateless servers (easy scaling)
  ❌ Never for real-time (latency = polling_interval / 2)
```

---

## WebSocket Gateway Architecture

### Overview

```
┌───────────┐                        ┌────────────────────┐
│  Client A  │ ←── WebSocket ──────→ │  Gateway Server 1  │
│  (Alice)   │                       │  (65K connections)  │
└───────────┘                        └────────┬───────────┘
                                              │
┌───────────┐                        ┌────────┴───────────┐
│  Client B  │ ←── WebSocket ──────→ │  Gateway Server 2  │
│  (Bob)     │                       │  (65K connections)  │
└───────────┘                        └────────┬───────────┘
                                              │
                                     ┌────────┴───────────┐
                                     │  Message Service    │
                                     │  (Kafka / Redis     │
                                     │   Pub/Sub)          │
                                     └────────┬───────────┘
                                              │
                                     ┌────────┴───────────┐
                                     │  Backend Services   │
                                     │  (auth, storage,    │
                                     │   business logic)   │
                                     └────────────────────┘
```

### Gateway Server Responsibilities

```
1. Connection Lifecycle:
   - Accept WebSocket handshake (upgrade from HTTP)
   - Authenticate user (validate JWT/session token)
   - Register connection in session registry
   - Handle heartbeat/ping-pong
   - Detect disconnection (heartbeat timeout, TCP close)
   - Clean up on disconnect (remove from registry)

2. Message Routing:
   - Receive messages from client → forward to Message Service
   - Receive messages from Message Service → push to connected client
   - Handle subscription management (which rooms/topics the client follows)

3. Protocol Translation:
   - Client speaks WebSocket protocol
   - Backend speaks Kafka/gRPC/HTTP
   - Gateway translates between them
```

### Connection Registry

```
Redis-based session registry:

On client connect:
  SET session:{user_id}:{device_id} gateway-server-7 EX 120
  SADD user_sessions:{user_id} {device_id}

On heartbeat (every 30s):
  EXPIRE session:{user_id}:{device_id} 120  (refresh TTL)

On disconnect:
  DEL session:{user_id}:{device_id}
  SREM user_sessions:{user_id} {device_id}

To find where a user is connected:
  SMEMBERS user_sessions:{user_id}
  → ["device_1", "device_2"]
  
  GET session:{user_id}:device_1 → "gateway-server-7"
  GET session:{user_id}:device_2 → "gateway-server-12"
```

---

## Connection Management at Scale

### File Descriptor Limits

```
Each WebSocket connection = 1 TCP socket = 1 file descriptor

Linux defaults:
  Per-process FD limit: 1,024 (default) → increase to 1,000,000
  System-wide FD limit: 65,536 (default) → increase to 10,000,000

Tuning for WebSocket gateways:
  ulimit -n 1000000          (per-process limit)
  sysctl -w fs.file-max=10000000  (system limit)
  net.ipv4.ip_local_port_range = 1024 65535  (ephemeral ports)

Practical limit per server:
  ~65K connections per IP:port pair
  Multiple IPs per server → 65K × N_IPs connections
  With 4 IPs: ~260K connections per server
  
  But memory is usually the bottleneck:
    Each connection: ~10-50 KB of memory (buffers, state)
    64 GB RAM server: ~1.3M connections at 50KB each
    32 GB RAM server: ~650K connections at 50KB each
```

### Server Count Calculation

```
10M concurrent users:

Conservative (65K per server):
  10,000,000 / 65,000 = 154 gateway servers

With tuning (250K per server):
  10,000,000 / 250,000 = 40 gateway servers

Cost:
  154 × c5.2xlarge ($0.34/hour) = $52/hour = $38,000/month
  40 × c5.4xlarge ($0.68/hour) = $27/hour = $19,700/month

WhatsApp's achievement:
  ~2M concurrent connections per server (Erlang, extreme optimization)
  10M users / 2M per server = 5 servers (theoretical minimum)
```

### Non-Blocking I/O (epoll)

```
Why NOT one thread per connection:
  10M connections × 1 thread each = 10M threads
  Each thread: ~1 MB stack space → 10 TB of RAM (impossible)
  Context switching: catastrophic performance

Solution: epoll (Linux) / kqueue (macOS) — event-driven I/O:
  1 thread monitors thousands of connections
  Only "wakes up" when data arrives on a socket
  No wasted CPU cycles on idle connections
  
  Model:
    Event loop thread: Monitors all sockets via epoll
    Data arrives on socket #4,721 → callback fires → process message
    Socket #4,721 goes idle → no CPU consumed
    
  Frameworks:
    Java: Netty (used by Discord, WhatsApp)
    Go: Built-in goroutines (lightweight, 2KB per goroutine)
    Node.js: Built-in event loop (libuv)
    Rust: Tokio
    C++: libuv, libevent
```

---

## Cross-Gateway Messaging

### The Problem

```
Alice is connected to Gateway 7.
Bob is connected to Gateway 12.
Alice sends a message to Bob.

Gateway 7 receives Alice's message → but Bob is on Gateway 12.
How does Gateway 7 deliver to Bob?
```

### Solution 1: Redis Pub/Sub

```
Architecture:
  Each gateway subscribes to a Redis Pub/Sub channel: "gateway:{server_id}"

Message flow:
  1. Alice (Gateway 7) → sends message to Bob
  2. Gateway 7 → Message Service: store message, determine Bob's gateway
  3. Message Service → Redis: PUBLISH gateway:12 {message_for_bob}
  4. Gateway 12 (subscribed to "gateway:12") receives message
  5. Gateway 12 → pushes message to Bob's WebSocket

Latency: ~5-10ms (Redis Pub/Sub is very fast)
Limitation: Redis Pub/Sub is fire-and-forget (no persistence)
  If Gateway 12 is temporarily down → message lost from Pub/Sub
  Solution: Also persist message in database, Pub/Sub is just the "fast path"
```

### Solution 2: Kafka for Cross-Gateway Messaging

```
Each gateway has a Kafka consumer group for its messages:

Message flow:
  1. Alice (Gateway 7) → sends message to Bob
  2. Gateway 7 → Kafka topic "messages" (partition by recipient_id)
  3. Message Service consumes → determines Bob's gateway (Gateway 12)
  4. Message Service → Kafka topic "gateway-delivery" (partition by gateway_id)
  5. Gateway 12 consumes from its partition → pushes to Bob

Advantage over Redis Pub/Sub:
  ✅ Persistent (messages survive gateway restarts)
  ✅ Replay capability (reconnecting client can catch up)
  ✅ Back-pressure handling (Kafka buffers overflow)
  
Disadvantage:
  ❌ Higher latency (~20-50ms vs ~5ms for Redis Pub/Sub)
```

### Solution 3: Hybrid (Most Common in Production)

```
Redis Pub/Sub (fast path):
  For messages to currently-connected users
  Fire-and-forget, ~5ms latency
  
Kafka (reliable path):
  For message persistence and delivery guarantee
  ~30ms latency

Flow:
  1. Store message in Cassandra (durability)
  2. Publish to Redis Pub/Sub (fast delivery to connected user)
  3. If user is offline → message waits in Cassandra
  4. When user reconnects → gateway fetches unread messages from Cassandra

This is how WhatsApp, Slack, and Discord handle it.
```

---

## Presence System (Online / Offline / Last Seen)

### Basic Presence with Redis TTL

```
Heartbeat-based presence:

Client sends heartbeat every 30 seconds:
  Gateway receives heartbeat → SET online:{user_id} 1 EX 70

Why TTL = 70 seconds (not 30)?
  Buffer for network jitter and missed heartbeats.
  If client misses ONE heartbeat, key doesn't expire immediately.
  Only 2 consecutive missed heartbeats → offline.

Check if user is online:
  GET online:{user_id}
  → "1" = online
  → nil = offline

Check multiple users (batch):
  MGET online:{id1} online:{id2} online:{id3} ... online:{id500}
  → Results in < 2ms for 500 contacts
```

### Last Seen Tracking

```
On heartbeat:
  SET last_seen:{user_id} {timestamp}
  SET online:{user_id} 1 EX 70

On explicit disconnect:
  SET last_seen:{user_id} {timestamp}
  DEL online:{user_id}

On TTL expiry (implicit disconnect):
  last_seen stays (no TTL on last_seen)
  online key expires → user shows as offline

Display logic:
  If online:{user_id} exists → "Online"
  Else → "Last seen {last_seen:{user_id}}"
  
  "Last seen 5 minutes ago"
  "Last seen today at 2:30 PM"
  "Last seen yesterday"
```

### Presence at Scale

```
500M users, 100M online simultaneously:

Redis memory for presence:
  100M keys × ~50 bytes (key + value + overhead) = 5 GB
  → Fits in a single Redis node (but use cluster for reliability)

Presence broadcasts to contacts:
  User comes online → notify all contacts who are also online
  
  Problem: User has 500 contacts, 200 are online
  → 200 Pub/Sub messages per status change
  → At 10K status changes/sec: 2M Pub/Sub messages/sec
  
  Optimization: Don't broadcast every heartbeat
  → Only broadcast on transition: offline → online, online → offline
  → Reduces to ~100K transitions/sec → 20M Pub/Sub messages/sec (manageable)
  
  Further optimization: Batch presence updates
  → Collect transitions over 5 seconds → send one batch notification per contact
  → Reduces to 4M messages/sec
```

### Privacy Controls

```
Presence privacy:
  User setting: "Show online status" → yes/no
  If no: Don't SET online:{user_id}, don't broadcast status
  
  WhatsApp approach:
    "Last seen" is a privacy setting
    If disabled: Other users see blank (not "offline")
    If enabled: "Last seen today at 2:30 PM"
```

---

## Heartbeat & Connection Health

### Client-Side Heartbeat

```
Client sends PING every 30 seconds:

WebSocket PING frame (2 bytes, minimal overhead):
  Client → PING → Server
  Server → PONG → Client (automatic in most implementations)

Application-level heartbeat (JSON):
  Client → {"type": "heartbeat", "ts": 1711234567}
  Server → {"type": "heartbeat_ack"}

Why application-level in addition to WebSocket PING?
  - Some proxies/load balancers swallow WebSocket PING frames
  - Application heartbeat can carry additional data (connection quality)
  - Easier to monitor and debug
```

### Server-Side Timeout Detection

```
Per-connection timer:

On connect:
  connection.last_heartbeat = now()
  schedule check_health(connection, 70_seconds_from_now)

On heartbeat received:
  connection.last_heartbeat = now()
  reschedule check_health(connection, 70_seconds_from_now)

check_health(connection):
  if now() - connection.last_heartbeat > 70 seconds:
    connection.close("heartbeat_timeout")
    cleanup_session(connection.user_id)
  else:
    reschedule check_health(connection, 70_seconds_from_now)
```

### Connection Recovery

```
Client disconnects (network switch, app background):

1. Client detects disconnect
2. Client waits 1 second → attempts reconnect
3. If fails → exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
4. On reconnect:
   a. Authenticate (send token)
   b. Server checks: any missed messages since last_seen_message_id?
   c. Server sends missed messages (catch-up)
   d. Resume normal operation

Catch-up query:
  SELECT * FROM messages 
  WHERE conversation_id IN (user's conversations)
  AND message_id > last_seen_message_id
  ORDER BY message_id ASC
  LIMIT 100
```

---

## Message Delivery Flow

### End-to-End Message Delivery

```
Alice sends "Hello Bob!" to Bob:

1. Alice → WebSocket → Gateway 7
   Gateway authenticates Alice, validates message

2. Gateway 7 → Message Service (gRPC/Kafka)
   Message Service validates, rate-limits, processes

3. Message Service → Cassandra
   INSERT INTO messages (conversation_id, message_id, sender_id, content, timestamp)
   VALUES ('conv_AB', 'msg_789', 'alice', 'Hello Bob!', now())

4. Message Service → Determine Bob's gateway
   GET session:bob:device_1 → "gateway-server-12"

5. Message Service → Redis Pub/Sub
   PUBLISH gateway:12 {"to":"bob", "msg":"Hello Bob!", "id":"msg_789"}

6. Gateway 12 receives Pub/Sub message
   Finds Bob's WebSocket connection
   Pushes message to Bob

7. Bob's client receives message → renders in UI
   Bob's client → Gateway 12: {"type":"ack", "msg_id":"msg_789"}

8. Gateway 12 → Message Service: Mark msg_789 as delivered

Total latency: ~30-50ms end-to-end

If Bob is OFFLINE:
  Step 4: GET session:bob → nil (not connected)
  Step 5: Skip Pub/Sub
  Message stays in Cassandra
  When Bob reconnects → catch-up query retrieves missed messages
  
  Additionally: Push notification (APNs / FCM) to Bob's phone
```

### Message Delivery Guarantees

```
At-least-once delivery:
  Server stores message in Cassandra BEFORE attempting delivery
  If delivery fails → message is safe in Cassandra → retry on reconnect
  Client deduplicates by message_id (idempotent processing)

Read receipts:
  1. Message stored → "sent" ✓ (single check)
  2. Message delivered to device → "delivered" ✓✓ (double check)
  3. User opens conversation → "read" (blue checks)
  
  Each state transition: ACK from client → update in database
```

---

## Scaling to Millions of Connections

### Load Balancing for WebSocket

```
Critical difference from HTTP:
  HTTP: Request → Response → Connection closed (stateless)
  WebSocket: Connection persists for minutes/hours (stateful)

WRONG: Round-robin load balancing
  Server A: 100K connections, Server B: 10K connections
  Round-robin assigns next connection to B (makes sense for HTTP)
  But for WebSocket: A is overloaded, B is underutilized

RIGHT: Least-connections load balancing
  ALB/NLB tracks active connection count per server
  New connection → route to server with fewest connections
  
  AWS ALB: Supports WebSocket natively with least-connections
  NGINX: proxy_pass with least_conn upstream directive
```

### Horizontal Scaling Strategy

```
Auto-scaling WebSocket gateways:

Scale-up triggers:
  - Connection count per server > 60K (approaching 65K limit)
  - CPU > 60% sustained for 5 minutes
  - Memory > 70% sustained for 5 minutes

Scale-down triggers (careful — connections are stateful!):
  - Connection count per server < 20K for 15 minutes
  - Drain connections before terminating: stop accepting new connections
    → Wait for existing connections to naturally disconnect
    → Force-close remaining after 5-minute grace period
    
  NEVER hard-terminate a gateway — always drain first.
  
Rolling deployment:
  1. Launch new gateway version alongside old
  2. Stop routing new connections to old gateways
  3. Old gateways drain (existing connections finish naturally)
  4. After drain period → terminate old gateways
  5. Zero downtime, zero dropped connections
```

### Connection Affinity

```
For some use cases (collaborative editing, gaming):
  Multiple events from same client must reach same backend worker
  
Sticky sessions:
  First WebSocket connection → assigned to Gateway 7
  All subsequent requests from same client → Gateway 7
  
  Implementation: Cookie-based or IP-hash based affinity at LB
  
  Downside: Uneven load distribution
  Mitigation: Re-balance periodically (force reconnect during low-traffic hours)
```

---

## Graceful Degradation

### Fallback Chain: WebSocket → SSE → Long Polling

```
Client connection strategy:

1. Try WebSocket
   ws://api.example.com/ws
   If successful → use WebSocket ✅
   If fails (proxy blocks, firewall, browser issue):
   
2. Try Server-Sent Events (SSE)
   https://api.example.com/events (EventSource API)
   Server → Client: SSE stream
   Client → Server: Regular HTTP POST for sending messages
   If fails (very old browser, corporate proxy):
   
3. Fall back to Long Polling
   Client: GET /messages?since={last_id}&timeout=30
   Server: Hold request for 30 seconds or until new message
   On response: Immediately issue next poll
   Highest latency, highest overhead, but works everywhere

Implementation (client-side):
  const transport = new TransportManager();
  transport.tryWebSocket()
    .catch(() => transport.trySSE())
    .catch(() => transport.useLongPolling());
```

### Graceful Degradation Under Load

```
Normal: Full real-time features
  - Typing indicators (ephemeral, 2-second TTL)
  - Presence updates (every status change)
  - Read receipts (per-message ACK)
  - Message delivery (instant via Pub/Sub)

Under pressure (CPU > 80%):
  - Disable typing indicators (reduces 40% of WebSocket traffic)
  - Batch presence updates (every 30s instead of real-time)
  - Keep message delivery (core feature, non-negotiable)

Critical load (CPU > 95%):
  - Disable presence entirely
  - Disable read receipts
  - Rate-limit message sends (max 1 message/sec per user)
  - Keep core message delivery
  
  Feature priority (never shed):
    1. Message delivery (core value)
    2. Connection health (heartbeat)
    3. Authentication
```

---

## Real-World System Examples

### WhatsApp

```
Technology: Erlang/OTP (designed for telecom, lightweight processes)
Connections: ~2M per server (Erlang's lightweight process model)
Architecture: Gateway servers + Ejabberd (XMPP-based message routing)
Delivery: Store-and-forward (messages persist in Mnesia/Cassandra)
Encryption: End-to-end (Signal Protocol, server can't read messages)
Presence: Heartbeat-based, Redis TTL
Multi-device: Limited (one phone + companion devices)
```

### Discord

```
Technology: Elixir/Erlang VM + Rust (for hot paths)
Connections: ~1M per gateway (Elixir's concurrency model)
Presence: Custom distributed presence service
Voice: WebRTC for real-time audio/video
Message storage: Cassandra (migrated to ScyllaDB)
Gateway: Custom protocol over WebSocket (binary, compressed)
Multi-server: Each guild (server) has an assigned gateway cluster
```

### Slack

```
Technology: Java + PHP (legacy) → Hack/HHVM
Connections: WebSocket for real-time, flannel service for messaging
Architecture: Cell-based (each workspace assigned to a cell)
Presence: Custom presence service with lazy loading
Multi-device: Full multi-device support with sync
Threads: Real-time updates within threads (separate subscription)
```

---

## Deep Dive: Applying Real-Time to Popular Problems

### Chat System (WhatsApp-like)

```
Gateway: 154 servers for 10M concurrent (65K each)
LB: NLB with least-connections
Session registry: Redis cluster
Message store: Cassandra (partition: conversation_id, cluster: message_id)
Cross-gateway: Redis Pub/Sub (fast) + Kafka (reliable)
Presence: Redis TTL (heartbeat every 30s, TTL 70s)
Offline: Push notification (FCM/APNs) + catch-up on reconnect
Delivery: At-least-once, client deduplicates by message_id
```

### Live Sports Scores / Stock Prices

```
Pattern: One producer → millions of subscribers (broadcast)

Architecture:
  Score service: Produces score updates → Kafka topic
  Gateway servers: Subscribe to Kafka topic
  Each gateway: Broadcasts to all connected clients on that server
  
  Not point-to-point (like chat) but broadcast (one-to-many)
  
  10M subscribers × 1 update/sec = 10M WebSocket pushes/sec
  154 gateways × ~65K pushes/sec each = 10M pushes/sec total ✅
  
Optimization:
  Group subscribers by "interest" (team, stock symbol)
  Only push relevant updates to each client
  Reduces total pushes by 90%+
```

### Collaborative Document Editing (Google Docs)

```
Pattern: Small group real-time (5-50 concurrent editors)

Architecture:
  Each document → one "session" on a gateway server
  All editors of same document → routed to same gateway (affinity)
  OT (Operational Transform) or CRDT applied server-side
  Changes broadcast to all editors on same document
  
  Conflict resolution: OT transforms concurrent edits
  Latency requirement: < 100ms (noticeable if slower)
  
  Connection affinity: Document ID → consistent hash → specific gateway
```

### Live Comments / Reactions (Facebook Live, Twitch Chat)

```
Pattern: High-throughput broadcast with potential for millions of viewers

Challenge: 1M viewers × 10 comments/sec = 10M messages/sec

Architecture:
  Viewers don't get ALL comments — they get a sampled stream
  Server: Receive all comments → sample top 100/sec → broadcast sample
  
  OR: Fan-out through Pub/Sub channels
  Room: "live_stream_123" → 1M subscribers across 16 gateway servers
  Each gateway fans out to its ~62K subscribers locally
  
  Comment arrives → Kafka → all gateways subscribing to room → broadcast
  
Rate limiting:
  Max 1 comment per user per 5 seconds (prevent spam)
  Server-side dedup + rate limit before broadcast
```

---

## Interview Talking Points & Scripts

### Script 1: Gateway Architecture and Scaling

> *"Each gateway server handles 65K-500K concurrent WebSocket connections using epoll-based non-blocking I/O — no thread-per-connection, which would require terabytes of stack memory at scale. For 10M concurrent users, we need ~20-154 gateway servers (depending on language: Erlang/Go handle 500K+, Java/Node closer to 100K) behind a Layer 4 NLB with least-connections routing. NOT round-robin — WebSocket connections are long-lived and heterogeneous in traffic, so round-robin creates hotspots. Each connection is registered in Redis: `HSET session:{user_id} gateway_id GW-7 connected_at {timestamp} device mobile`. This registry is the foundation for cross-gateway routing."*

### Script 2: Cross-Gateway Message Delivery (The Complete Flow)

> *"When Alice on Gateway 7 messages Bob on Gateway 12, the message goes through a precise pipeline: (1) Alice's WebSocket → Gateway 7 validates and forwards to Message Service. (2) Message Service persists to Cassandra FIRST (durability guarantee — never lose a message), assigns a message_id and conversation-level sequence number, then publishes to Redis Pub/Sub targeting Gateway 12's channel. (3) Gateway 12 pushes via Bob's WebSocket. (4) Bob's client renders and sends a client-side ACK (`{type: 'ack', msg_id: 'xyz'}`). (5) Server records delivery status. End-to-end: ~30-50ms. If Bob is offline — no session key in Redis — we skip the push, message stays in Cassandra's outbox, and we fire a push notification via FCM/APNs. On reconnect, Bob's client sends its last_seen_sequence, and the server replays all missed messages in order."*

### Script 3: Presence System (Online/Offline/Last Seen)

> *"Presence uses heartbeat + Redis TTL — the client sends a ping every 30 seconds, gateway refreshes: `EXPIRE presence:{user_id} 70`. If two heartbeats are missed (70s), the key expires → user transitions to 'offline'. The CRITICAL optimization: we broadcast ONLY on state transitions (online→offline, offline→online), not on every heartbeat. Without this, 10M users × heartbeat every 30s = 333K Redis writes/sec just for presence. With transition-only broadcasting, we process maybe 50K state-change events/sec at peak — 85% less traffic. For 'last seen', we `SET last_seen:{user_id} {timestamp}` on disconnect. Checking 500 contacts' presence is a single `MGET` — under 2ms. For the UI, I'd also batch presence queries: load all 500 contacts' presence in one request on app open, then rely on push events for subsequent changes."*

### Script 4: Graceful Degradation Under Load

> *"Under load, we shed non-critical real-time features in priority order — this is what separates production systems from whiteboard designs. First shed: typing indicators (saves 30-40% of WebSocket traffic, purely cosmetic — 'Alice is typing' is nice-to-have, not essential). Second: batch presence to 30-second intervals (users tolerate 'online' being 30s delayed). Third: read receipts (batch every 10s). Fourth: reduce heartbeat frequency from 30s to 60s. NEVER shed: message delivery, authentication, or minimum heartbeat. If the entire WebSocket layer is overwhelmed, clients fall back automatically: WebSocket → SSE (unidirectional, still push-based, auto-reconnect) → long-polling (30s hold, HTTP-based, works everywhere). The client SDK implements this as a state machine with automatic detection and recovery."*

### Script 5: Connection Lifecycle and Reconnection

> *"In production, connections are fragile — mobile users traverse tunnels, switch between WiFi and cellular, apps get backgrounded. My reconnection protocol handles this: on disconnect, the client uses exponential backoff with jitter (1s, 2s, 4s, 8s cap, plus random 0-50% jitter) to avoid thundering herd when a gateway crashes and 500K clients try to reconnect simultaneously. On reconnect, the client presents a session token (not full re-auth) and its `last_received_sequence_number`. The server replays all missed messages since that sequence — no data loss. If the gap is too large (>1000 messages), the server sends a snapshot instead of replaying all ops. For ordering, each conversation has its own monotonically increasing sequence counter — clients reorder locally if messages arrive out of sequence."*

### Script 6: Fan-Out for Broadcast Scenarios (1-to-Millions)

> *"For broadcast scenarios — live sports scores to 10M subscribers, stock price ticks to 5M traders — point-to-point fan-out is impossible. I'd use hierarchical fan-out: the source publishes to a Kafka topic. Each gateway server is a consumer in the same consumer group — Kafka delivers ONE copy per gateway. Each gateway then does LOCAL fan-out to its 100K-500K relevant subscribers. So pushing to 10M clients requires only 20-100 Kafka messages (one per gateway), not 10M individual pushes. Each gateway maintains an in-memory subscription map: `symbol → [connection_ids]`. When AAPL price changes, the gateway pushes only to connections subscribed to AAPL — not to all 500K connections. This reduces actual push volume by 90%+ compared to naive fan-out."*

### Script 7: Group Chat and Channel Architecture

> *"For Slack-like channels with thousands of members, I'd give each channel its own Redis Pub/Sub channel — NOT fan-out per user. When a message arrives in #general (5000 members, spread across 50 gateways), the publish is ONE Redis PUBLISH that all 50 subscribed gateways receive. Each gateway then locally pushes to its connected members of that channel (maybe 100 users per gateway). The gateway keeps an in-memory mapping: `channel_id → [local_connection_ids]`. Join/leave only updates the local set + Redis metadata. This makes group messages O(num_gateways) not O(num_members). For very large channels (100K+ members like a company-wide announce channel), we further optimize by batching pushes and only pushing to users who have the channel actively visible."*

### Script 8: Memory and Resource Planning

> *"Each WebSocket connection costs ~8-16 KB total: 4 KB kernel TCP socket buffers (tunable via net.ipv4.tcp_rmem), 2-10 KB application state (user_id, device info, subscriptions, message buffers). For a gateway with 500K connections: 500K × 16 KB = 8 GB RAM. I'd use 32 GB machines for headroom. File descriptors: 500K connections = 500K fds — need to set `ulimit -n 1000000` and `fs.file-max` accordingly. Network: at 1 KB average message size and 100 messages/sec per gateway, that's 100 MB/sec — well within 10 Gbps NIC. CPU: epoll is O(1) per event, so even 500K connections with sporadic traffic use minimal CPU. The bottleneck is almost always the cross-gateway messaging (Redis Pub/Sub throughput), not the gateway itself."*

---

## Common Interview Mistakes

### ❌ Mistake 1: "I'd use HTTP polling for real-time chat"
**Why it's wrong**: Polling at 1-second intervals for 10M users = 10M requests/sec = massive server load. 99% return empty.
**Better**: WebSocket for persistent connections. Server pushes only when data exists.

### ❌ Mistake 2: Not addressing cross-gateway messaging
**Why it's wrong**: With 154 gateway servers, sender and receiver are almost never on the same gateway. Must explain how messages route between them.
**Better**: Redis Pub/Sub for fast delivery + Kafka/Cassandra for persistence.

### ❌ Mistake 3: "One thread per WebSocket connection"
**Why it's wrong**: 10M threads would require 10 TB of stack memory. Context switching would kill CPU.
**Better**: Non-blocking I/O (epoll) — one thread monitors thousands of connections.

### ❌ Mistake 4: Using round-robin load balancing for WebSocket
**Why it's wrong**: WebSocket connections are long-lived and stateful. Round-robin leads to uneven load.
**Better**: Least-connections load balancing (ALB/NLB tracks active connection count).

### ❌ Mistake 5: Not mentioning graceful degradation
**Why it's wrong**: The system should degrade gracefully under load, not crash.
**Better**: Shed non-essential features (typing indicators, presence) before shedding core messaging.

### ❌ Mistake 6: Forgetting offline message delivery
**Why it's wrong**: Users are offline most of the time. Messages must persist and be delivered on reconnect.
**Better**: Persist in Cassandra first, push via WebSocket if online, catch-up query on reconnect.

---

## Summary Cheat Sheet

```
┌──────────────────────────────────────────────────────────────┐
│         WEBSOCKET & REAL-TIME AT SCALE CHEAT SHEET           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  CONNECTIONS:                                                │
│    65K per server (file descriptor limit)                    │
│    10M users → ~154 gateway servers                          │
│    Non-blocking I/O (epoll): No thread per connection        │
│    LB: Least-connections (NOT round-robin)                   │
│                                                              │
│  SESSION REGISTRY (Redis):                                   │
│    session:{user_id}:{device} → gateway_server_id            │
│    Enables cross-gateway message routing                     │
│                                                              │
│  CROSS-GATEWAY:                                              │
│    Redis Pub/Sub (fast, ~5ms) for real-time delivery         │
│    Kafka (reliable, ~30ms) for persistence + replay          │
│    Hybrid: Both (fast + reliable)                            │
│                                                              │
│  PRESENCE:                                                   │
│    Heartbeat every 30s → Redis key with 70s TTL              │
│    Broadcast ONLY on transitions (online↔offline)            │
│    Batch MGET for contact list (500 contacts < 2ms)          │
│                                                              │
│  MESSAGE DELIVERY:                                           │
│    1. Persist in Cassandra (durability)                      │
│    2. Push via Pub/Sub (if online, ~30ms)                    │
│    3. If offline → catch-up on reconnect + push notification │
│    4. Client deduplicates by message_id                      │
│                                                              │
│  DEGRADATION (in order):                                     │
│    1. Shed typing indicators (saves 40% traffic)             │
│    2. Batch presence updates                                 │
│    3. Disable read receipts                                  │
│    NEVER shed: Message delivery, heartbeat, auth             │
│                                                              │
│  FALLBACK: WebSocket → SSE → Long Polling                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Related Topics

- **Topic 7: Push vs Pull (Fanout)** — Fanout patterns for real-time feeds
- **Topic 8: Synchronous vs Asynchronous** — Async messaging for real-time
- **Topic 9: Communication Protocols** — Protocol comparison (gRPC, HTTP, WebSocket)
- **Topic 10: Message Queues vs Event Streams** — Kafka/Redis for cross-gateway messaging
- **Topic 15: Rate Limiting** — Rate limiting WebSocket messages

---

*This document is part of the 44-topic System Design Interview Deep Dive series, based on the 200+ Comprehensive System Design Interview Talking Points.*