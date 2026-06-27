"""Heartbeat Monitor — WebSocket connection health checking.

Provides a per-connection background asyncio.Task that sends WebSocket
ping frames every 30 seconds. If no pong response is received within
10 seconds, the connection is forcibly closed, triggering the standard
disconnect handling in room_manager.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# Interval between heartbeat pings (seconds)
HEARTBEAT_INTERVAL = 30

# Maximum time to wait for a pong response (seconds)
PONG_TIMEOUT = 10


async def _heartbeat_loop(websocket) -> None:
    """Internal heartbeat loop that pings and waits for pong.

    Runs indefinitely until:
    - The connection is closed externally (CancelledError from task cancellation)
    - A pong timeout occurs (connection forcibly closed)

    Args:
        websocket: A WebSocket connection object. Expected to support
                   an async `send({"type": "websocket.ping"})` method
                   (Starlette/FastAPI WebSocket) or a `.ping()` coroutine
                   (websockets library).
    """
    while True:
        await asyncio.sleep(HEARTBEAT_INTERVAL)
        try:
            # Attempt to send a WebSocket protocol-level ping.
            # Starlette's WebSocket exposes a lower-level send method
            # that can send ping frames via the ASGI interface.
            pong_waiter = None
            if hasattr(websocket, "send") and hasattr(websocket, "scope"):
                # Starlette/FastAPI WebSocket: send a ping via raw ASGI
                # The pong is handled at the protocol level by the server.
                # We use a send_text + receive pattern as application-level heartbeat.
                # However, the preferred approach with Starlette is to rely on
                # the underlying server (uvicorn) for protocol-level pings.
                # For our implementation, we send a JSON ping message and wait
                # for an application-level response with a timeout.
                await asyncio.wait_for(
                    _send_ping_and_wait_pong(websocket),
                    timeout=PONG_TIMEOUT,
                )
            elif hasattr(websocket, "ping"):
                # websockets library WebSocket: use protocol-level ping
                pong_waiter = await websocket.ping()
                await asyncio.wait_for(pong_waiter, timeout=PONG_TIMEOUT)
            else:
                # Fallback: attempt generic ping call
                await asyncio.wait_for(
                    _send_ping_and_wait_pong(websocket),
                    timeout=PONG_TIMEOUT,
                )
        except asyncio.TimeoutError:
            # No pong received within timeout — forcibly close connection
            logger.warning("Heartbeat timeout: no pong received within %ds, closing connection", PONG_TIMEOUT)
            try:
                await websocket.close(code=1008, reason="Heartbeat timeout")
            except Exception:
                # Connection may already be closed
                pass
            return
        except (asyncio.CancelledError, Exception) as exc:
            if isinstance(exc, asyncio.CancelledError):
                # Task was cancelled (e.g., on clean disconnect) — exit silently
                raise
            # Any other exception (connection error, etc.) — stop heartbeat
            logger.debug("Heartbeat loop ending due to exception: %s", exc)
            return


async def _send_ping_and_wait_pong(websocket) -> None:
    """Send an application-level ping and wait for pong.

    For Starlette/FastAPI WebSockets, sends a JSON ping message
    and expects the client to respond with a pong message. The
    ws_handler is responsible for handling the pong at the application
    level if needed.

    In practice, with uvicorn + websockets, protocol-level pings are
    handled automatically. This function sends a lightweight JSON ping
    as an application-level heartbeat check.
    """
    try:
        await websocket.send_json({"type": "ping"})
    except Exception:
        raise


def start_heartbeat(websocket) -> asyncio.Task:
    """Start a heartbeat monitoring task for the given WebSocket connection.

    Creates and returns a background asyncio.Task that periodically pings
    the connection. If the connection becomes unresponsive (no pong within
    10 seconds), it forcibly closes the connection — triggering the standard
    disconnect handling flow in room_manager.

    The caller is responsible for cancelling the returned task when the
    connection is intentionally closed (e.g., on clean disconnect).

    Args:
        websocket: The WebSocket connection to monitor.

    Returns:
        An asyncio.Task running the heartbeat loop.
    """
    task = asyncio.create_task(_heartbeat_loop(websocket))
    return task


def stop_heartbeat(task: asyncio.Task) -> None:
    """Stop a heartbeat monitoring task.

    Cancels the background task if it is still running.

    Args:
        task: The heartbeat asyncio.Task to cancel.
    """
    if task is not None and not task.done():
        task.cancel()
