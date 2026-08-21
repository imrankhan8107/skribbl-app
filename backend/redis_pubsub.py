"""Redis pub/sub adapter for cross-worker message broadcasting.

When running with multiple workers, each worker subscribes to a Redis channel
for its rooms. When a broadcast needs to reach players on other workers,
it's published to Redis. Other workers receive it and forward to their local clients.

If REDIS_URL is not set, this module is a no-op (single-worker mode).
"""

import asyncio
import json
import logging
import os
from typing import Optional, Callable, Awaitable
from uuid import uuid4

logger = logging.getLogger(__name__)

# Redis URL from environment (e.g., "redis://localhost:6379")
REDIS_URL = os.environ.get("REDIS_URL", "")

# Unique identifier for this worker process
WORKER_ID = str(uuid4())

_redis_client = None
_pubsub = None
_subscriber_task: Optional[asyncio.Task] = None
_message_handler: Optional[Callable[[str, dict], Awaitable[None]]] = None


async def init_redis(handler: Callable[[str, dict], Awaitable[None]]) -> None:
    """Initialize Redis connection and start subscriber.

    Args:
        handler: Async callback(channel, message_dict) called when a message
                 is received from another worker. The channel is the room_code.
    """
    global _redis_client, _pubsub, _subscriber_task, _message_handler

    if not REDIS_URL:
        logger.info("REDIS_URL not set — running in single-worker mode")
        return

    try:
        import redis.asyncio as aioredis
        _redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
        _pubsub = _redis_client.pubsub()
        _message_handler = handler
        # Subscribe to a worker-specific control channel to establish the connection
        await _pubsub.subscribe(f"worker:{WORKER_ID}")
        _subscriber_task = asyncio.create_task(_subscribe_loop())
        logger.info("Redis pub/sub initialized (worker=%s): %s", WORKER_ID, REDIS_URL)
    except ImportError:
        logger.warning("redis package not installed — running in single-worker mode")
    except Exception as e:
        logger.error("Failed to connect to Redis: %s", e)


async def _subscribe_loop():
    """Background task that listens for messages from Redis pub/sub."""
    while True:
        try:
            message = await _pubsub.get_message(
                ignore_subscribe_messages=True, timeout=1.0
            )
            if message and message["type"] == "message":
                channel = message["channel"]
                data = json.loads(message["data"])
                # Ignore messages from ourselves
                if data.get("source_worker") == WORKER_ID:
                    continue
                # Handle RPC requests (worker-to-worker)
                if "rpc" in data and _message_handler:
                    await _message_handler(channel, data)
                elif "message" in data and _message_handler:
                    await _message_handler(channel, data)
            else:
                # No message — yield to event loop briefly
                await asyncio.sleep(0.01)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Redis subscriber error: %s", e)
            await asyncio.sleep(1)
            await asyncio.sleep(1)


async def subscribe_room(room_code: str) -> None:
    """Subscribe this worker to a room's Redis channel."""
    if _pubsub is None:
        return
    await _pubsub.subscribe(f"room:{room_code}")


async def unsubscribe_room(room_code: str) -> None:
    """Unsubscribe this worker from a room's Redis channel."""
    if _pubsub is None:
        return
    await _pubsub.unsubscribe(f"room:{room_code}")


async def publish_to_room(room_code: str, message: dict) -> None:
    """Publish a message to a room's Redis channel for other workers.

    Args:
        room_code: The room to broadcast to.
        message: The message dict to publish.
    """
    if _redis_client is None:
        return

    payload = json.dumps({
        "source_worker": WORKER_ID,
        "message": message,
    })
    await _redis_client.publish(f"room:{room_code}", payload)


async def register_room_worker(room_code: str) -> None:
    """Register which worker owns a room.

    Uses both a hash (for fast lookup) and an individual key with TTL
    (for automatic cleanup if the worker crashes without unregistering).
    """
    if _redis_client is None:
        return
    await _redis_client.hset("room_workers", room_code, WORKER_ID)
    # Per-room TTL key — expires in 1 hour if not refreshed (room deleted)
    await _redis_client.set(f"room_owner:{room_code}", WORKER_ID, ex=3600)


async def get_room_worker(room_code: str) -> Optional[str]:
    """Get which worker owns a room."""
    if _redis_client is None:
        return None
    return await _redis_client.hget("room_workers", room_code)


async def remove_room_worker(room_code: str) -> None:
    """Remove a room from the worker registry."""
    if _redis_client is None:
        return
    await _redis_client.hdel("room_workers", room_code)
    await _redis_client.delete(f"room_owner:{room_code}")


async def get_room_info(room_code: str) -> Optional[dict]:
    """Get basic room info from Redis (state, player count, config).

    Returns None if room not found in registry.
    """
    if _redis_client is None:
        return None
    info = await _redis_client.hget("room_info", room_code)
    if info is None:
        return None
    import json as _json
    return _json.loads(info)


async def set_room_info(room_code: str, info: dict) -> None:
    """Store basic room info in Redis for cross-worker discovery."""
    if _redis_client is None:
        return
    import json as _json
    await _redis_client.hset("room_info", room_code, _json.dumps(info))


async def remove_room_info(room_code: str) -> None:
    """Remove room info from Redis."""
    if _redis_client is None:
        return
    await _redis_client.hdel("room_info", room_code)


async def publish_rpc_request(target_worker: str, request: dict) -> None:
    """Publish an RPC request to a specific worker's channel."""
    if _redis_client is None:
        return
    payload = json.dumps({
        "source_worker": WORKER_ID,
        "rpc": request,
    })
    await _redis_client.publish(f"worker:{target_worker}", payload)


async def forward_to_room_owner(room_code: str, player_id: str, message: dict) -> None:
    """Forward a player's message to the worker that owns the room.

    Used by proxy workers to relay player actions (guesses, strokes, etc.)
    to the owning worker for authoritative processing.

    Args:
        room_code: The room code the message belongs to.
        player_id: The ID of the player who sent the message.
        message: The original message dict from the client.
    """
    owner_worker = await get_room_worker(room_code)
    if owner_worker is None:
        return
    await publish_rpc_request(owner_worker, {
        "type": "forward_message",
        "room_code": room_code,
        "player_id": player_id,
        "message": message,
    })


# ═══════════════════════════════════════════════════════════════════════════════
# LOAD-AWARE ROOM PLACEMENT
# ═══════════════════════════════════════════════════════════════════════════════


async def wait_for_rpc_response(request_id: str, timeout: float = 5.0) -> Optional[dict]:
    """Wait for an RPC response on a temporary Redis key (polling).

    The responding worker writes the response to a Redis key, and this
    method polls for it.
    """
    if _redis_client is None:
        return None
    key = f"rpc_response:{request_id}"
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = await _redis_client.get(key)
        if result is not None:
            await _redis_client.delete(key)
            return json.loads(result)
        await asyncio.sleep(0.05)
    return None


async def set_rpc_response(request_id: str, response: dict) -> None:
    """Set an RPC response for a waiting caller."""
    if _redis_client is None:
        return
    await _redis_client.set(f"rpc_response:{request_id}", json.dumps(response), ex=10)


# ═══════════════════════════════════════════════════════════════════════════════
# Load-Aware Room Placement
# ═══════════════════════════════════════════════════════════════════════════════


async def report_worker_load(room_count: int, connection_count: int) -> None:
    """Report this worker's current load to a Redis sorted set.

    Used by the room creation logic to pick the least-loaded worker
    for new rooms (prevents hotspots under round-robin routing).

    Args:
        room_count: Number of active rooms on this worker.
        connection_count: Number of active WebSocket connections.
    """
    if _redis_client is None:
        return
    # Score = connection_count (route new rooms to least-connected worker)
    await _redis_client.zadd("worker_load", {WORKER_ID: connection_count})
    # Also store room count for observability
    await _redis_client.hset("worker_rooms", WORKER_ID, room_count)
    # TTL: if a worker crashes, its entry expires after 60s
    await _redis_client.expire("worker_load", 120)


async def get_least_loaded_worker() -> Optional[str]:
    """Find the worker with the fewest active connections.

    Returns the worker_id of the least-loaded worker, or None if
    no load data is available.
    """
    if _redis_client is None:
        return None
    # Get worker with lowest score (fewest connections)
    result = await _redis_client.zrange("worker_load", 0, 0)
    if result:
        return result[0]
    return None


async def get_all_worker_loads() -> dict:
    """Get load info for all workers (for observability/debugging).

    Returns dict of {worker_id: connection_count}.
    """
    if _redis_client is None:
        return {}
    result = await _redis_client.zrange("worker_load", 0, -1, withscores=True)
    return {worker_id: int(score) for worker_id, score in result}


# ═══════════════════════════════════════════════════════════════════════════════
# Per-Room TTL (stale room cleanup)
# ═══════════════════════════════════════════════════════════════════════════════


async def register_room_with_ttl(room_code: str, ttl_seconds: int = 3600) -> None:
    """Register room ownership with a TTL for automatic stale cleanup.

    If a worker crashes without unregistering, the room entry expires
    after ttl_seconds so joiners don't get stuck routing to a dead worker.

    Args:
        room_code: The room code to register.
        ttl_seconds: How long the entry lives before auto-expiry (default 1 hour).
    """
    if _redis_client is None:
        return
    # Use a per-room key with TTL instead of the hash (hashes can't have per-field TTL)
    await _redis_client.set(f"room_owner:{room_code}", WORKER_ID, ex=ttl_seconds)
    # Also keep the hash for backward compatibility
    await _redis_client.hset("room_workers", room_code, WORKER_ID)


async def refresh_room_ttl(room_code: str, ttl_seconds: int = 3600) -> None:
    """Refresh the TTL on a room's registry entry (call periodically for active rooms).

    Args:
        room_code: The room code to refresh.
        ttl_seconds: New TTL to set.
    """
    if _redis_client is None:
        return
    await _redis_client.expire(f"room_owner:{room_code}", ttl_seconds)


async def get_room_worker_with_ttl(room_code: str) -> Optional[str]:
    """Get room owner, preferring the TTL-based key over the hash.

    Falls back to the hash if the per-room key doesn't exist (backward compat).
    """
    if _redis_client is None:
        return None
    # Try per-room key first (has TTL)
    owner = await _redis_client.get(f"room_owner:{room_code}")
    if owner is not None:
        return owner
    # Fallback to hash
    return await _redis_client.hget("room_workers", room_code)


async def unregister_room_with_ttl(room_code: str) -> None:
    """Remove room from both per-room key and hash."""
    if _redis_client is None:
        return
    await _redis_client.delete(f"room_owner:{room_code}")
    await _redis_client.hdel("room_workers", room_code)


def is_redis_enabled() -> bool:
    """Check if Redis is configured and connected."""
    return _redis_client is not None


def get_worker_id() -> str:
    """Get this worker's unique ID."""
    return WORKER_ID


async def shutdown_redis() -> None:
    """Clean shutdown of Redis connections.

    Also removes this worker's load entry from the sorted set.
    """
    global _subscriber_task, _pubsub, _redis_client
    # Remove load entry before shutting down
    if _redis_client:
        try:
            await _redis_client.zrem("worker_load", WORKER_ID)
        except Exception:
            pass
    if _subscriber_task:
        _subscriber_task.cancel()
        try:
            await _subscriber_task
        except asyncio.CancelledError:
            pass
    if _pubsub:
        await _pubsub.close()
    if _redis_client:
        await _redis_client.close()
    _subscriber_task = None
    _pubsub = None
    _redis_client = None
