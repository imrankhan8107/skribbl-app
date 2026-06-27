"""Unit tests for the heartbeat module."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.heartbeat import (
    HEARTBEAT_INTERVAL,
    PONG_TIMEOUT,
    start_heartbeat,
    stop_heartbeat,
    _heartbeat_loop,
)


class FakeWebSocket:
    """A fake WebSocket that simulates Starlette/FastAPI WebSocket behavior."""

    def __init__(self, *, respond_to_ping=True, close_on_send=False):
        self.respond_to_ping = respond_to_ping
        self.close_on_send = close_on_send
        self.closed = False
        self.close_code = None
        self.close_reason = None
        self.messages_sent = []
        self.scope = {}  # Presence of scope indicates Starlette WebSocket

    async def send_json(self, data):
        if self.close_on_send:
            raise RuntimeError("Connection closed")
        self.messages_sent.append(data)
        if not self.respond_to_ping:
            # Simulate no pong by blocking indefinitely
            await asyncio.sleep(999)

    async def close(self, code=1000, reason=""):
        self.closed = True
        self.close_code = code
        self.close_reason = reason

    # Indicate this is a Starlette-style WebSocket
    async def send(self, data):
        pass


class FakeWebSocketWithPing:
    """A fake WebSocket that has a .ping() method (websockets library style)."""

    def __init__(self, *, pong_responds=True):
        self.pong_responds = pong_responds
        self.closed = False
        self.close_code = None
        self.ping_count = 0

    async def ping(self):
        self.ping_count += 1
        future = asyncio.get_event_loop().create_future()
        if self.pong_responds:
            future.set_result(None)
        # If pong_responds is False, future never resolves (simulating timeout)
        return future

    async def close(self, code=1000, reason=""):
        self.closed = True
        self.close_code = code


@pytest.mark.asyncio
async def test_start_heartbeat_returns_task():
    """start_heartbeat should return an asyncio.Task."""
    ws = FakeWebSocket(respond_to_ping=True)
    task = start_heartbeat(ws)
    assert isinstance(task, asyncio.Task)
    # Clean up
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_stop_heartbeat_cancels_task():
    """stop_heartbeat should cancel a running task."""
    ws = FakeWebSocket(respond_to_ping=True)
    task = start_heartbeat(ws)
    assert not task.done()
    stop_heartbeat(task)
    # Give event loop time to process cancellation
    await asyncio.sleep(0.01)
    assert task.done()


@pytest.mark.asyncio
async def test_stop_heartbeat_noop_for_none():
    """stop_heartbeat should handle None gracefully."""
    stop_heartbeat(None)  # Should not raise


@pytest.mark.asyncio
async def test_stop_heartbeat_noop_for_done_task():
    """stop_heartbeat should not raise for already-done tasks."""
    ws = FakeWebSocket(respond_to_ping=True)
    task = start_heartbeat(ws)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    # Task is done now; stop_heartbeat should not raise
    stop_heartbeat(task)


@pytest.mark.asyncio
async def test_heartbeat_sends_ping_after_interval():
    """Heartbeat should send a ping after HEARTBEAT_INTERVAL seconds."""
    ws = FakeWebSocket(respond_to_ping=True)

    with patch("backend.heartbeat.HEARTBEAT_INTERVAL", 0.05):
        task = start_heartbeat(ws)
        # Wait enough time for at least one ping
        await asyncio.sleep(0.1)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # Should have sent at least one ping message
    assert len(ws.messages_sent) >= 1
    assert ws.messages_sent[0] == {"type": "ping"}


@pytest.mark.asyncio
async def test_heartbeat_closes_on_pong_timeout():
    """If pong is not received within timeout, connection should be closed."""
    ws = FakeWebSocket(respond_to_ping=False)

    with patch("backend.heartbeat.HEARTBEAT_INTERVAL", 0.02), \
         patch("backend.heartbeat.PONG_TIMEOUT", 0.05):
        task = start_heartbeat(ws)
        # Wait for interval + timeout + buffer
        await asyncio.sleep(0.15)
        # Task should have completed (not cancelled, but returned)
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert ws.closed
    assert ws.close_code == 1008


@pytest.mark.asyncio
async def test_heartbeat_with_websockets_library_ping():
    """Heartbeat should use .ping() for websockets-library-style sockets."""
    ws = FakeWebSocketWithPing(pong_responds=True)

    with patch("backend.heartbeat.HEARTBEAT_INTERVAL", 0.02):
        task = start_heartbeat(ws)
        await asyncio.sleep(0.06)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert ws.ping_count >= 1
    assert not ws.closed


@pytest.mark.asyncio
async def test_heartbeat_with_websockets_library_pong_timeout():
    """Heartbeat should close if .ping() pong future times out."""
    ws = FakeWebSocketWithPing(pong_responds=False)

    with patch("backend.heartbeat.HEARTBEAT_INTERVAL", 0.02), \
         patch("backend.heartbeat.PONG_TIMEOUT", 0.05):
        task = start_heartbeat(ws)
        await asyncio.sleep(0.15)
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert ws.closed
    assert ws.close_code == 1008


@pytest.mark.asyncio
async def test_heartbeat_exits_on_send_error():
    """If sending a ping raises an error, heartbeat should exit gracefully."""
    ws = FakeWebSocket(close_on_send=True)

    with patch("backend.heartbeat.HEARTBEAT_INTERVAL", 0.02), \
         patch("backend.heartbeat.PONG_TIMEOUT", 0.05):
        task = start_heartbeat(ws)
        await asyncio.sleep(0.15)
        # Task should have exited (either via timeout or exception handling)
        assert task.done()


@pytest.mark.asyncio
async def test_heartbeat_constants():
    """Verify heartbeat constants match requirements."""
    assert HEARTBEAT_INTERVAL == 30
    assert PONG_TIMEOUT == 10
