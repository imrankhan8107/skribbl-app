"""Unit tests for VirtualTransport adapter."""

import asyncio
import json

import pytest

from backend.proto.game_pb2 import BroadcastMessage
from backend.virtual_transport import VirtualTransport


@pytest.fixture
def send_queue():
    return asyncio.Queue()


@pytest.fixture
def transport(send_queue):
    return VirtualTransport(
        player_id="player-123",
        room_code="ABC123",
        send_queue=send_queue,
    )


async def test_send_text_produces_correct_broadcast_message(transport, send_queue):
    """send_text enqueues a BroadcastMessage with correct fields."""
    await transport.send_text("hello world")

    msg = await send_queue.get()
    assert isinstance(msg, BroadcastMessage)
    assert msg.room_code == "ABC123"
    assert msg.message_type == "targeted"
    assert msg.payload == b"hello world"
    assert list(msg.target_player_ids) == ["player-123"]


async def test_send_text_encodes_utf8(transport, send_queue):
    """send_text encodes data as UTF-8 bytes."""
    await transport.send_text("café ☕ 日本語")

    msg = await send_queue.get()
    assert msg.payload == "café ☕ 日本語".encode("utf-8")


async def test_send_json_serializes_dict(transport, send_queue):
    """send_json serializes a dict to JSON then sends via send_text."""
    data = {"type": "ping", "payload": {"value": 42}}
    await transport.send_json(data)

    msg = await send_queue.get()
    assert json.loads(msg.payload.decode("utf-8")) == data
    assert msg.room_code == "ABC123"
    assert list(msg.target_player_ids) == ["player-123"]


async def test_send_text_preserves_ordering(transport, send_queue):
    """Multiple send_text calls preserve message order in the queue."""
    await transport.send_text("msg1")
    await transport.send_text("msg2")
    await transport.send_text("msg3")

    m1 = await send_queue.get()
    m2 = await send_queue.get()
    m3 = await send_queue.get()
    assert m1.payload == b"msg1"
    assert m2.payload == b"msg2"
    assert m3.payload == b"msg3"


async def test_send_text_empty_string(transport, send_queue):
    """send_text handles empty string."""
    await transport.send_text("")

    msg = await send_queue.get()
    assert msg.payload == b""
    assert msg.room_code == "ABC123"
    assert list(msg.target_player_ids) == ["player-123"]


async def test_send_text_large_payload(transport, send_queue):
    """send_text handles large payloads."""
    data = "x" * 100_000
    await transport.send_text(data)

    msg = await send_queue.get()
    assert msg.payload == data.encode("utf-8")


async def test_send_text_is_awaitable(transport, send_queue):
    """send_text is a coroutine (awaitable)."""
    coro = transport.send_text("test")
    assert asyncio.iscoroutine(coro)
    await coro


async def test_send_json_is_awaitable(transport, send_queue):
    """send_json is a coroutine (awaitable)."""
    coro = transport.send_json({"key": "value"})
    assert asyncio.iscoroutine(coro)
    await coro


async def test_send_room_uses_explicit_room_code(transport, send_queue):
    """send_room prioritizes explicit room_code over transport.room_code."""
    await transport.send_room('{"type": "chat"}', room_code="XYZ789")

    msg = await send_queue.get()
    assert isinstance(msg, BroadcastMessage)
    assert msg.room_code == "XYZ789"
    assert msg.message_type == "broadcast"
    assert msg.payload == b'{"type": "chat"}'


async def test_send_room_falls_back_to_transport_room_code(transport, send_queue):
    """send_room falls back to transport.room_code if room_code not provided."""
    await transport.send_room('{"type": "chat"}')

    msg = await send_queue.get()
    assert isinstance(msg, BroadcastMessage)
    assert msg.room_code == "ABC123"
    assert msg.message_type == "broadcast"


async def test_backpressure_drops_lossy_when_queue_full():
    """When bounded send_queue is full, lossy messages are dropped without error."""
    bounded_queue = asyncio.Queue(maxsize=2)
    vt = VirtualTransport(player_id="p1", room_code="ROOM1", send_queue=bounded_queue)

    # Fill queue to capacity
    await vt.send_room('{"type": "stroke_1"}', lossy=True)
    await vt.send_room('{"type": "stroke_2"}', lossy=True)
    assert bounded_queue.full()

    # Third lossy message should be dropped silently
    await vt.send_room('{"type": "stroke_3"}', lossy=True)
    assert bounded_queue.qsize() == 2

    m1 = await bounded_queue.get()
    m2 = await bounded_queue.get()
    assert m1.payload == b'{"type": "stroke_1"}'
    assert m2.payload == b'{"type": "stroke_2"}'


async def test_backpressure_evicts_older_for_control_when_queue_full():
    """When bounded send_queue is full, control (lossy=False) messages evict older items."""
    bounded_queue = asyncio.Queue(maxsize=2)
    vt = VirtualTransport(player_id="p1", room_code="ROOM1", send_queue=bounded_queue)

    # Fill queue
    await vt.send_room('{"type": "stroke_1"}', lossy=True)
    await vt.send_room('{"type": "stroke_2"}', lossy=True)
    assert bounded_queue.full()

    # Control message must evict oldest item to ensure delivery
    await vt.send_room('{"type": "game_over"}', lossy=False)
    assert bounded_queue.qsize() == 2

    # Oldest (stroke_1) was evicted; stroke_2 and game_over remain
    m1 = await bounded_queue.get()
    m2 = await bounded_queue.get()
    assert m1.payload == b'{"type": "stroke_2"}'
    assert m2.payload == b'{"type": "game_over"}'



