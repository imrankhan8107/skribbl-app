"""gRPC service discovery registration in Redis.

Handles registering this worker's gRPC address in Redis so the Go gateway
can discover and connect to it. Follows the same patterns as redis_pubsub.py
for worker address registration and liveness keys.

Key scheme:
  - worker_grpc_addresses (Hash): worker_id -> "hostname:grpc_port"
  - worker_grpc_alive:{worker_id} (String): "1" with 30s TTL (refreshed every 10s)

If REDIS_URL is not set or the gRPC server never binds, registration is a no-op.
"""

import asyncio
import logging
import os

from backend import redis_pubsub

logger = logging.getLogger(__name__)

# gRPC port from environment (default 50051)
GRPC_PORT = int(os.environ.get("GRPC_PORT", "50051"))

# Whether gRPC is enabled (can be disabled explicitly via env)
GRPC_ENABLED = os.environ.get("GRPC_ENABLED", "true").lower() in ("true", "1", "yes")

# Redis key scheme
_GRPC_ADDRESSES_HASH = "worker_grpc_addresses"
_GRPC_ALIVE_KEY_PREFIX = "worker_grpc_alive:"

# Liveness key TTL and refresh cadence (Requirement 8.2)
_GRPC_ALIVE_TTL = 30  # seconds
_REFRESH_INTERVAL = 10  # seconds

# Module-level state
_refresh_task: "asyncio.Task | None" = None
_registered: bool = False


def _alive_key(worker_id: str) -> str:
    """Build the liveness key for a worker."""
    return f"{_GRPC_ALIVE_KEY_PREFIX}{worker_id}"


async def register_grpc_worker(
    worker_id: str,
    hostname: str,
    grpc_port: "int | None" = None,
) -> None:
    """Register this worker's gRPC address in Redis.

    Called on startup once the gRPC server has successfully bound its port.
    Registers the address in the `worker_grpc_addresses` hash, sets the
    initial liveness key with a 30s TTL, and starts the background refresh
    task that keeps the liveness key alive.

    If Redis is not enabled, this is a no-op (WebSocket-only mode).

    Args:
        worker_id: This worker's unique ID (from redis_pubsub.WORKER_ID).
        hostname: Docker container hostname reachable by the gateway.
        grpc_port: The gRPC port (defaults to GRPC_PORT env var).
    """
    global _refresh_task, _registered

    if not redis_pubsub.is_redis_enabled():
        logger.info("Redis not enabled — skipping gRPC registration")
        return

    redis_client = redis_pubsub._redis_client
    if redis_client is None:
        logger.info("Redis client unavailable — skipping gRPC registration")
        return

    port = grpc_port if grpc_port is not None else GRPC_PORT
    address = f"{hostname}:{port}"

    try:
        await redis_client.hset(_GRPC_ADDRESSES_HASH, worker_id, address)
        await redis_client.set(_alive_key(worker_id), "1", ex=_GRPC_ALIVE_TTL)
        _registered = True
        logger.info(
            "Registered gRPC address: %s (worker_id=%s)", address, worker_id
        )
    except Exception as e:
        logger.error("Failed to register gRPC address in Redis: %s", e)
        return

    # Start the background liveness refresh loop
    _refresh_task = asyncio.create_task(_refresh_liveness_loop(worker_id))


async def _refresh_liveness_loop(worker_id: str) -> None:
    """Background loop: refresh the liveness key every _REFRESH_INTERVAL seconds.

    Re-sets `worker_grpc_alive:{worker_id}` with a 30s TTL so the gateway
    can detect whether this worker's gRPC server is still reachable.
    """
    while True:
        try:
            await asyncio.sleep(_REFRESH_INTERVAL)
            redis_client = redis_pubsub._redis_client
            if redis_client is None:
                continue
            await redis_client.set(
                _alive_key(worker_id), "1", ex=_GRPC_ALIVE_TTL
            )
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning("Failed to refresh gRPC liveness key: %s", e)


async def unregister_grpc_worker(worker_id: str) -> None:
    """Remove this worker's gRPC registration from Redis on graceful shutdown.

    Cancels the liveness refresh task, removes the hash entry from
    `worker_grpc_addresses`, and deletes the liveness key so the gateway
    stops routing new gRPC streams to this worker immediately.

    Safe to call even if the worker was never registered.

    Args:
        worker_id: This worker's unique ID.
    """
    global _refresh_task, _registered

    # Cancel the refresh task first
    if _refresh_task is not None:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass
        _refresh_task = None

    if not _registered:
        return

    redis_client = redis_pubsub._redis_client
    if redis_client is None:
        _registered = False
        return

    try:
        await redis_client.hdel(_GRPC_ADDRESSES_HASH, worker_id)
        await redis_client.delete(_alive_key(worker_id))
        logger.info("Unregistered gRPC address (worker_id=%s)", worker_id)
    except Exception as e:
        logger.warning("Failed to unregister gRPC address: %s", e)
    finally:
        _registered = False


def is_grpc_registered() -> bool:
    """Check if this worker's gRPC address is currently registered."""
    return _registered
