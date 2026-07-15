# Scaling to 1 Million Concurrent Users

## Current Architecture Limits

| Component | Current Capacity | Bottleneck |
|-----------|-----------------|------------|
| Single Python worker | ~500 connections | GIL / event loop saturation |
| 3 workers + Redis | ~1,500 connections | Redis single-instance throughput |
| nginx (single node) | ~10,000 connections | `worker_connections` config |
| Redis (single instance) | ~100,000 msgs/sec | CPU-bound, single-threaded |

To reach **1,000,000 concurrent users** (~125,000 active rooms at 8 players each), we need fundamental changes across every layer.

---

## Target Architecture

```
                                ┌─────────────────────────────────┐
                                │      Global Load Balancer        │
                                │   (AWS ALB / Azure Front Door)   │
                                │   GeoDNS → nearest region        │
                                └──────────┬──────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
            ┌───────┴───────┐    ┌────────┴────────┐    ┌───────┴───────┐
            │  Region: US    │    │  Region: EU     │    │  Region: Asia  │
            └───────┬───────┘    └────────┬────────┘    └───────┬───────┘
                    │                     │                      │
         ┌──────────┴──────────┐          │                     │
         │                     │          │                     │
    ┌────┴─────┐         ┌────┴─────┐    │                     │
    │ Cluster A │         │ Cluster B │   ...                   ...
    │ (nginx)   │         │ (nginx)   │
    └────┬─────┘         └────┬─────┘
         │                     │
    ┌────┴────────────────────┴────┐
    │    Room Server Pods (K8s)     │
    │    ~200 pods per cluster      │
    │    ~2,500 connections each    │
    └────────────┬─────────────────┘
                 │
    ┌────────────┴─────────────────┐
    │   Redis Cluster (6+ nodes)    │
    │   Sharded by room_code hash   │
    └────────────┬─────────────────┘
                 │
    ┌────────────┴─────────────────┐
    │   Room Registry Service       │
    │   (Redis / DynamoDB / etcd)   │
    │   room_code → pod assignment  │
    └──────────────────────────────┘
```

---

## Architectural Changes Required

### 1. Room Registry Service (New Component)

**Problem:** With 200+ worker pods, you can't rely on sticky cookies alone. A new player joining room "ABC123" needs to know *which pod* owns that room.

**Solution:** A lightweight registry mapping `room_code → pod_id`:

```python
# New file: backend/room_registry.py

import redis.asyncio as redis

class RoomRegistry:
    """Distributed room-to-pod mapping using Redis."""

    def __init__(self, redis_client: redis.Redis, pod_id: str):
        self.redis = redis_client
        self.pod_id = pod_id

    async def register_room(self, room_code: str) -> None:
        """Register that this pod owns a room."""
        await self.redis.hset("room_registry", room_code, self.pod_id)
        await self.redis.expire("room_registry", 86400)

    async def lookup_room(self, room_code: str) -> str | None:
        """Find which pod owns a room."""
        pod = await self.redis.hget("room_registry", room_code)
        return pod.decode() if pod else None

    async def unregister_room(self, room_code: str) -> None:
        """Remove a room from the registry (room closed)."""
        await self.redis.hdel("room_registry", room_code)

    async def get_least_loaded_pod(self) -> str:
        """Find the pod with fewest active rooms for room creation."""
        # Each pod publishes its load to a sorted set
        result = await self.redis.zrangebyscore(
            "pod_load", "-inf", "+inf", start=0, num=1
        )
        return result[0].decode() if result else self.pod_id

    async def report_load(self, room_count: int, connection_count: int) -> None:
        """Report this pod's current load for routing decisions."""
        score = connection_count  # Route to least-connected pod
        await self.redis.zadd("pod_load", {self.pod_id: score})
        await self.redis.expire("pod_load", 60)
```

### 2. Connection Router / Gateway Layer (New Component)

**Problem:** The current nginx config does sticky sessions by cookie, but joining a room requires routing to the *specific pod* that owns that room.

**Solution:** A lightweight gateway service that inspects the first message and routes accordingly:

```python
# New file: backend/gateway.py
"""
Lightweight WebSocket gateway that routes connections to the correct room pod.

Flow:
1. Client connects to gateway
2. Client sends create_room or join_room
3. Gateway looks up room_registry to find target pod
4. Gateway proxies the WebSocket to that pod
   OR returns a redirect URL for the client to reconnect directly

For create_room: gateway picks the least-loaded pod.
For join_room: gateway looks up the owning pod.
"""

import aiohttp
from fastapi import FastAPI, WebSocket

app = FastAPI()

@app.websocket("/ws")
async def gateway_ws(websocket: WebSocket):
    await websocket.accept()

    # Read the first message to determine routing
    raw = await websocket.receive_text()
    msg = json.loads(raw)

    if msg["type"] == "create_room":
        target_pod = await registry.get_least_loaded_pod()
    elif msg["type"] in ("join_room", "reconnect"):
        room_code = msg["payload"]["room_code"]
        target_pod = await registry.lookup_room(room_code)
        if not target_pod:
            await websocket.send_json({
                "type": "error",
                "payload": {"code": "ROOM_NOT_FOUND", "message": "Room not found"}
            })
            await websocket.close()
            return

    # Option A: Redirect client to connect directly to the pod
    await websocket.send_json({
        "type": "redirect",
        "payload": {"url": f"wss://{target_pod}/ws"}
    })

    # Option B: Proxy the connection (transparent to client)
    # await proxy_websocket(websocket, target_pod, raw)
```

**Client-side change** for redirect approach:

```typescript
// In WebSocketContext.tsx — handle redirect
if (msg.type === "redirect") {
    const newUrl = msg.payload.url;
    ws.close();
    // Reconnect to the assigned pod
    const newWs = new WebSocket(newUrl);
    // Re-send the original message...
}
```

### 3. Redis Cluster (Replace Single Redis)

**Problem:** Single Redis instance maxes out at ~100K msgs/sec. With 1M users and 125K rooms, broadcast traffic could hit 500K+ msgs/sec.

**Solution:** Redis Cluster with hash-based sharding:

```python
# Updated backend/redis_pubsub.py

import redis.asyncio as redis
from redis.asyncio.cluster import RedisCluster

REDIS_URL = os.environ.get("REDIS_URL")
REDIS_CLUSTER_URLS = os.environ.get("REDIS_CLUSTER_URLS")  # comma-separated

async def init_redis(message_handler):
    global _redis, _pubsub

    if REDIS_CLUSTER_URLS:
        # Cluster mode — sharded by channel name (room_code)
        nodes = [{"host": h, "port": int(p)}
                 for url in REDIS_CLUSTER_URLS.split(",")
                 for h, p in [url.split(":")]]
        _redis = RedisCluster(startup_nodes=nodes)
    elif REDIS_URL:
        _redis = redis.from_url(REDIS_URL)
    else:
        return  # Single-worker mode

    await _redis.ping()
    # Subscribe logic unchanged — Redis Cluster handles routing
```

**Capacity:** 6-node Redis Cluster handles ~600K msgs/sec (6× single instance).

### 4. Language Change for Hot Path (Optional but High Impact)

**Problem:** Python's GIL limits a single worker to ~500 concurrent connections and ~7K msgs/sec. To serve 1M users, you'd need ~2,000 Python workers. That's expensive and operationally complex.

**Option A: Rewrite WebSocket layer in Go or Rust**

A single Go process can handle 100K+ concurrent WebSocket connections. You'd need only ~10 Go instances instead of 2,000 Python ones.

```go
// Example: Go WebSocket handler using gorilla/websocket
// Each connection is a goroutine (~4KB stack, not a thread)
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, _ := upgrader.Upgrade(w, r, nil)
    playerID := uuid.New().String()

    go readPump(conn, playerID)   // reads messages
    go writePump(conn, playerID)  // sends broadcasts
}
```

**Option B: Keep Python but use a connection multiplexer**

Use a Go/Rust "connection gateway" that holds 100K connections but forwards game logic to Python workers via gRPC:

```
Client ──WS──► Go Gateway (100K conns) ──gRPC──► Python Game Logic (stateful rooms)
```

This preserves your Python game logic while offloading the connection bottleneck.

**Option C: Use uvloop + multiple processes (pragmatic)**

```bash
# Run 4 uvicorn workers per container with uvloop
uvicorn backend.main:app --workers 4 --loop uvloop --host 0.0.0.0 --port 8000
```

With `uvloop`, each worker handles ~1000 connections (2× improvement). 4 workers per pod × 250 pods = 1M connections. This is the easiest change but needs shared-nothing room isolation per worker.

### 5. Horizontal Pod Autoscaling (Kubernetes)

```yaml
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: skribbl-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: skribbl-app
  minReplicas: 10
  maxReplicas: 500
  metrics:
    - type: Pods
      pods:
        metric:
          name: websocket_connections
        target:
          type: AverageValue
          averageValue: "2000"  # Scale when avg connections per pod > 2000
```

### 6. Connection Draining and Room Migration

**Problem:** When a pod scales down or restarts, active rooms are lost.

**Solution:** Graceful drain + room state serialization:

```python
# backend/room_migration.py

import json
import signal

async def handle_shutdown(sig, frame):
    """On SIGTERM, serialize all rooms to Redis and close connections gracefully."""
    for room_code, room in room_manager._rooms.items():
        state = serialize_room(room)
        await redis.set(f"room_snapshot:{room_code}", json.dumps(state), ex=300)

    # Notify all clients to reconnect (they'll be routed to another pod)
    for room in room_manager._rooms.values():
        await room_manager.broadcast(room.code, {
            "type": "server_migration",
            "payload": {"message": "Reconnecting...", "retry_ms": 2000}
        })

    # Give clients time to receive the message
    await asyncio.sleep(2)
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_shutdown)
```

**Client-side:**

```typescript
// Handle server_migration message
if (msg.type === "server_migration") {
    // Wait and reconnect
    setTimeout(() => {
        ws.close();
        const newWs = new WebSocket(wsUrl);
        // Will trigger auto-reconnect flow
    }, msg.payload.retry_ms);
}
```

### 7. Observability at Scale

```python
# backend/metrics.py
from prometheus_client import Counter, Gauge, Histogram

ws_connections = Gauge('ws_connections_active', 'Active WebSocket connections')
rooms_active = Gauge('rooms_active', 'Active rooms on this pod')
message_latency = Histogram('message_latency_seconds', 'Message processing time',
                           buckets=[0.001, 0.005, 0.01, 0.05, 0.1])
broadcasts_total = Counter('broadcasts_total', 'Total broadcasts sent',
                          ['message_type'])
```

---

## Summary of Required Changes

### New Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| Room Registry | room_code → pod mapping | Redis hash / DynamoDB |
| Connection Gateway | Route & proxy WebSocket connections | Go or nginx + Lua |
| Pod Load Reporter | Publish connection counts | Background task per pod |
| Room Migration | Serialize rooms on pod shutdown | Redis snapshots |
| Metrics Exporter | Prometheus metrics | Python `prometheus_client` |

### Code Changes to Existing Files

| File | Change |
|------|--------|
| `backend/main.py` | Add uvloop, multi-process workers, metrics endpoint, shutdown handler |
| `backend/room_manager.py` | Register/unregister rooms in registry on create/delete; report load |
| `backend/redis_pubsub.py` | Support Redis Cluster; shard channels by room_code |
| `backend/ws_handler.py` | Add `server_migration` handling; metrics instrumentation |
| `frontend/src/context/WebSocketContext.tsx` | Handle `redirect` and `server_migration` messages; reconnect to different URL |
| `docker-compose.yml` | Add Redis Cluster nodes, gateway service, Prometheus |
| `nginx.conf` | Route to gateway layer; increase `worker_connections` to 65535 |

### Infrastructure

| Change | Why |
|--------|-----|
| Kubernetes (EKS / AKS / GKE) | Pod autoscaling, rolling deployments |
| Redis Cluster (6+ nodes) | Sharded pub/sub for 500K+ msgs/sec |
| Global Load Balancer | GeoDNS to nearest region |
| Multi-region deployment | Latency < 50ms for global users |
| CDN for frontend assets | Offload static file serving |
| Managed WebSocket service (optional) | AWS API Gateway WebSocket / Azure Web PubSub |

---

## Cost Estimate at 1M Users

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| 50× game pods (4 vCPU, 8GB) | Handle ~20K connections each | ~$3,000 |
| 6-node Redis Cluster | r6g.large (13GB each) | ~$1,200 |
| 3× Gateway nodes | c6g.large (2 vCPU) | ~$200 |
| Load Balancer (ALB) | WebSocket-aware | ~$100 |
| Kubernetes control plane | EKS / AKS | ~$150 |
| CDN (CloudFront) | Frontend static assets | ~$50 |
| Monitoring (Prometheus + Grafana) | Managed | ~$200 |
| **Total** | | **~$5,000/month** |

Note: This assumes 1M *concurrent* users (not monthly). Monthly users could be 10–50× higher with the same infrastructure since most players are only online for short sessions.

---

## Migration Path (Incremental)

You don't need to build all of this at once. Scale incrementally:

| Milestone | Users | What to Build |
|-----------|-------|---------------|
| Current | 500 | Single worker, no Redis |
| Phase 1 | 5,000 | Redis + nginx + 10 workers (current architecture) |
| Phase 2 | 50,000 | Room registry + gateway + Redis Cluster + uvloop |
| Phase 3 | 200,000 | Kubernetes + autoscaling + Go gateway |
| Phase 4 | 1,000,000 | Multi-region + room migration + full observability |

Each phase builds on the previous one. You'd hit Phase 2 problems around 20–50K concurrent users, which is already a very successful game.

---

## Alternative: Managed WebSocket Services

Instead of building all this yourself, consider offloading WebSocket connection management:

| Service | Handles | You Still Own |
|---------|---------|---------------|
| AWS API Gateway WebSocket | Connection management, routing | Game logic in Lambda/ECS |
| Azure Web PubSub | Connection management, pub/sub | Game logic in Container Apps |
| Ably / Pusher | Everything connection-related | Game logic via webhooks |

These services handle 1M+ connections out of the box but add latency (10–30ms) and cost ($0.30–1.00 per million messages). For a drawing game where stroke latency matters, self-hosted is better for the hot path.
