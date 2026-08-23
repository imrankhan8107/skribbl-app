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
