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
                if _message_handler:
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
    """Register which worker owns a room (stored in Redis hash)."""
    if _redis_client is None:
        return
    await _redis_client.hset("room_workers", room_code, WORKER_ID)


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


def is_redis_enabled() -> bool:
    """Check if Redis is configured and connected."""
    return _redis_client is not None


def get_worker_id() -> str:
    """Get this worker's unique ID."""
    return WORKER_ID


async def shutdown_redis() -> None:
    """Clean shutdown of Redis connections."""
    global _subscriber_task, _pubsub, _redis_client
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
