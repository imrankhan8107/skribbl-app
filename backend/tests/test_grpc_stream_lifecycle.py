"""Integration tests for keepalive and stream lifecycle behavior.

Tests:
1. Stream cancellation: verify players marked disconnected after stream cancel
2. Multiple streams: verify independent operation and isolation
3. Buffer overflow (VirtualTransport queue behavior): verify rapid message
   accumulation in the asyncio.Queue

Since the keepalive and buffer overflow logic lives in the Go gateway,
these Python-side tests verify what we CAN test from the worker perspective:
- Stream context cancellation triggers cleanup (handle_disconnect)
- Multiple concurrent streams operate independently
- The VirtualTransport queue accumulates messages correctly under load

Validates: Requirements 10.3, 10.5
"""

import asyncio
import json
import uuid

import grpc
import grpc.aio
import pytest

from backend.grpc_server import start_grpc_server
from backend.grpc_metrics import get_grpc_metrics, reset_metrics
from backend.proto.game_pb2 import GameMessage, BroadcastMessage
from backend.proto.game_pb2_grpc import GameServiceStub
from backend.virtual_transport import VirtualTransport
from backend.ws_handler import room_manager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TEST_PORT = 50063  # Use a different port from other test files to avoid conflicts


def _make_game_message(
    player_id: str, room_code: str, message_type: str, payload: dict | None = None
) -> GameMessage:
    """Construct a GameMessage protobuf."""
    return GameMessage(
        player_id=player_id,
        room_code=room_code,
        message_type=message_type,
        payload=json.dumps(payload or {}).encode("utf-8"),
    )


def _decode_payload(msg: BroadcastMessage) -> dict:
    """Decode a BroadcastMessage's payload from bytes to dict."""
    return json.loads(msg.payload.decode("utf-8"))


async def _read_until_type(
    stream, message_type: str, *, timeout: float = 10.0, max_messages: int = 50
) -> BroadcastMessage:
    """Read messages from a gRPC stream until one with the given message_type is found."""
    deadline = asyncio.get_event_loop().time() + timeout
    for _ in range(max_messages):
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            break
        try:
            msg = await asyncio.wait_for(stream.read(), timeout=remaining)
            if msg == grpc.aio.EOF:
                break
            payload = _decode_payload(msg)
            if payload.get("type") == message_type:
                return msg
        except asyncio.TimeoutError:
            break
    raise AssertionError(
        f"Did not receive message of type '{message_type}' within {timeout}s"
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_rooms():
    """Reset room_manager state between tests for isolation."""
    room_manager.rooms.clear()
    room_manager._player_to_room.clear()
    reset_metrics()
    yield
    room_manager.rooms.clear()
    room_manager._player_to_room.clear()
    reset_metrics()


@pytest.fixture
async def grpc_server():
    """Start an in-process gRPC server and yield it; stop on teardown."""
    server = await start_grpc_server(port=_TEST_PORT)
    yield server
    await server.stop(grace=1)


@pytest.fixture
async def grpc_channel(grpc_server):
    """Create a grpc.aio channel connected to the in-process server."""
    channel = grpc.aio.insecure_channel(f"localhost:{_TEST_PORT}")
    yield channel
    await channel.close()


@pytest.fixture
def stub(grpc_channel):
    """Create a GameServiceStub from the channel."""
    return GameServiceStub(grpc_channel)


# ---------------------------------------------------------------------------
# 1. Stream Cancellation Tests
# ---------------------------------------------------------------------------


class TestStreamCancellation:
    """Test that stream cancellation triggers proper player cleanup.

    When a gRPC stream context is cancelled (simulating keepalive timeout
    or network failure detected by the Go gateway), the Python worker must:
    - Mark all players on that stream as disconnected
    - Clean up their VirtualTransport instances
    - Trigger handle_disconnect for each player

    Validates: Requirements 10.5
    """

    async def test_stream_cancel_marks_player_disconnected(self, stub):
        """Cancelling a stream marks the player as disconnected.

        When only one player exists in a room, handle_disconnect in LOBBY
        state deletes the room entirely (no connected players remain).
        We verify the room is deleted, proving cleanup ran.
        """
        player_id = str(uuid.uuid4())

        # Create a room via the gRPC stream
        stream = stub.RoomStream()
        await stream.write(
            _make_game_message(player_id, "", "create_room", {"name": "StreamPlayer"})
        )

        # Read room_created response
        msg = await _read_until_type(stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        room_code = payload["payload"]["room_code"]
        actual_player_id = payload["payload"]["player_id"]

        # Verify the player is connected and room exists
        room = room_manager.rooms.get(room_code)
        assert room is not None
        player = room.get_player(actual_player_id)
        assert player is not None
        assert player.is_connected is True

        # Cancel the stream (simulates keepalive timeout / stream marked dead)
        # done_writing signals EOF to the server, then cancel to force context close
        await stream.done_writing()
        stream.cancel()

        # Give the server time to process the stream closure and cleanup
        # The cleanup chain: inbound loop ends → sentinel → yield loop exits → cleanup
        await asyncio.sleep(2.0)

        # When only one player is in a room and they disconnect,
        # handle_disconnect deletes the room (no connected players remain in LOBBY)
        # So the room should no longer exist — this proves cleanup ran
        assert room_manager.rooms.get(room_code) is None

    async def test_stream_cancel_cleans_up_multiple_players(self, stub):
        """When a stream is cancelled, all players on it are disconnected.

        With two players on the same stream, after cancel:
        - Both get handle_disconnect called
        - Since both disconnect, no connected players remain → room is deleted
        """
        host_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())

        # Host creates a room
        host_stream = stub.RoomStream()
        await host_stream.write(
            _make_game_message(host_id, "", "create_room", {"name": "Host"})
        )

        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        room_code = payload["payload"]["room_code"]
        actual_host_id = payload["payload"]["player_id"]

        # Player 2 joins on the same stream (simulating same Room_Stream)
        await host_stream.write(
            _make_game_message(
                player2_id, room_code, "join_room",
                {"name": "Player2", "room_code": room_code}
            )
        )

        # Read join response
        msg = await _read_until_type(host_stream, "room_joined", timeout=5.0)
        join_payload = _decode_payload(msg)
        actual_p2_id = join_payload["payload"]["player_id"]

        # Verify both players are connected
        room = room_manager.rooms[room_code]
        assert room.get_player(actual_host_id).is_connected is True
        assert room.get_player(actual_p2_id).is_connected is True

        # Cancel the stream
        await host_stream.done_writing()
        host_stream.cancel()
        await asyncio.sleep(2.0)

        # Both players disconnected via handle_disconnect.
        # With no connected players remaining in LOBBY, the room gets deleted.
        # This proves cleanup ran for all players on the stream.
        room = room_manager.rooms.get(room_code)
        if room is not None:
            # If room still exists, both players should be disconnected
            host_player = room.get_player(actual_host_id)
            p2_player = room.get_player(actual_p2_id)
            if host_player is not None:
                assert host_player.is_connected is False
            if p2_player is not None:
                assert p2_player.is_connected is False
        # Room deleted is also acceptable — proves cleanup ran

    async def test_stream_cancel_decrements_metrics(self, stub):
        """Stream cancellation decrements the grpc_streams_serving gauge."""
        player_id = str(uuid.uuid4())

        # Open a stream
        stream = stub.RoomStream()
        await stream.write(
            _make_game_message(player_id, "", "create_room", {"name": "MetricsPlayer"})
        )
        await _read_until_type(stream, "room_created", timeout=5.0)

        # Metric should be incremented (stream is active)
        metrics = get_grpc_metrics()
        assert metrics["grpc_streams_serving"] >= 1

        # Cancel the stream
        await stream.done_writing()
        await asyncio.sleep(0.5)

        # Metric should be decremented
        metrics = get_grpc_metrics()
        assert metrics["grpc_streams_serving"] == 0


# ---------------------------------------------------------------------------
# 2. Multiple Streams (Independent Operation)
# ---------------------------------------------------------------------------


class TestMultipleStreams:
    """Test that multiple concurrent gRPC streams operate independently.

    Each stream corresponds to a different room. Closing one stream should
    not affect others.

    Validates: Requirements 10.5
    """

    async def test_multiple_streams_independent_rooms(self, stub):
        """Two separate streams for different rooms operate independently."""
        player1_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())

        # Player 1 creates room on stream 1
        stream1 = stub.RoomStream()
        await stream1.write(
            _make_game_message(player1_id, "", "create_room", {"name": "Player1"})
        )
        msg = await _read_until_type(stream1, "room_created", timeout=5.0)
        room1_code = _decode_payload(msg)["payload"]["room_code"]
        actual_p1_id = _decode_payload(msg)["payload"]["player_id"]

        # Player 2 creates room on stream 2
        stream2 = stub.RoomStream()
        await stream2.write(
            _make_game_message(player2_id, "", "create_room", {"name": "Player2"})
        )
        msg = await _read_until_type(stream2, "room_created", timeout=5.0)
        room2_code = _decode_payload(msg)["payload"]["room_code"]
        actual_p2_id = _decode_payload(msg)["payload"]["player_id"]

        # Both rooms exist and both players are connected
        assert room1_code in room_manager.rooms
        assert room2_code in room_manager.rooms
        assert room_manager.rooms[room1_code].get_player(actual_p1_id).is_connected is True
        assert room_manager.rooms[room2_code].get_player(actual_p2_id).is_connected is True

        # Close stream 1 — should NOT affect stream 2
        await stream1.done_writing()
        stream1.cancel()
        await asyncio.sleep(2.0)

        # Player 2's room and connection should be unaffected
        room2 = room_manager.rooms.get(room2_code)
        assert room2 is not None
        p2 = room2.get_player(actual_p2_id)
        assert p2 is not None
        assert p2.is_connected is True

        # Player 1's room should be deleted (single player, disconnected in LOBBY)
        # This proves stream1 cleanup ran without affecting stream2
        assert room_manager.rooms.get(room1_code) is None

        # Clean up stream 2
        await stream2.done_writing()

    async def test_closing_one_stream_leaves_others_active(self, stub):
        """Closing one stream does not trigger errors on other active streams."""
        player1_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())
        player3_id = str(uuid.uuid4())

        # Create 3 streams with 3 rooms
        stream1 = stub.RoomStream()
        await stream1.write(
            _make_game_message(player1_id, "", "create_room", {"name": "Alpha"})
        )
        msg = await _read_until_type(stream1, "room_created", timeout=5.0)
        room1_code = _decode_payload(msg)["payload"]["room_code"]

        stream2 = stub.RoomStream()
        await stream2.write(
            _make_game_message(player2_id, "", "create_room", {"name": "Beta"})
        )
        msg = await _read_until_type(stream2, "room_created", timeout=5.0)
        room2_code = _decode_payload(msg)["payload"]["room_code"]

        stream3 = stub.RoomStream()
        await stream3.write(
            _make_game_message(player3_id, "", "create_room", {"name": "Gamma"})
        )
        msg = await _read_until_type(stream3, "room_created", timeout=5.0)
        room3_code = _decode_payload(msg)["payload"]["room_code"]
        actual_p3_id = _decode_payload(msg)["payload"]["player_id"]

        # Close stream 2
        await stream2.done_writing()
        await asyncio.sleep(0.3)

        # Stream 3 should still work — send a toggle_ready and get a response
        await stream3.write(
            _make_game_message(actual_p3_id, room3_code, "toggle_ready", {})
        )
        msg = await _read_until_type(stream3, "player_list", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "player_list"

        # Clean up
        await stream1.done_writing()
        await stream3.done_writing()


# ---------------------------------------------------------------------------
# 3. Buffer Overflow — VirtualTransport Queue Accumulation
# ---------------------------------------------------------------------------


class TestBufferOverflow:
    """Test that VirtualTransport queue correctly accumulates rapid messages.

    The actual 500-message buffer overflow logic lives in the Go gateway's
    MessageBuffer. On the Python side, we verify that the asyncio.Queue
    correctly accumulates all messages sent through VirtualTransport when
    they aren't being consumed (simulating a reconnection window where
    the gateway buffers outbound messages).

    Validates: Requirements 10.3
    """

    async def test_queue_accumulates_rapid_messages(self):
        """VirtualTransport queue accumulates all messages when not drained."""
        send_queue: asyncio.Queue = asyncio.Queue()
        transport = VirtualTransport("player-1", "ROOM01", send_queue)

        # Send 600 messages rapidly (simulating burst > 500 during reconnection)
        message_count = 600
        for i in range(message_count):
            await transport.send_text(json.dumps({"seq": i, "data": f"msg-{i}"}))

        # All 600 messages should be in the queue (Python queue is unbounded)
        assert send_queue.qsize() == message_count

        # Verify ordering — oldest messages first (FIFO)
        for i in range(message_count):
            msg = send_queue.get_nowait()
            payload = json.loads(msg.payload.decode("utf-8"))
            assert payload["seq"] == i
            assert msg.target_player_ids == ["player-1"]
            assert msg.room_code == "ROOM01"

    async def test_queue_preserves_order_under_load(self):
        """Messages enqueued rapidly maintain strict FIFO ordering."""
        send_queue: asyncio.Queue = asyncio.Queue()
        transport = VirtualTransport("player-x", "ROOMAB", send_queue)

        # Send 1000 messages (simulates exceeding the Go gateway's 500 buffer limit)
        count = 1000
        for i in range(count):
            await transport.send_json({"index": i, "type": "stroke"})

        # Drain and verify strict ordering
        messages = []
        while not send_queue.empty():
            messages.append(send_queue.get_nowait())

        assert len(messages) == count
        for i, msg in enumerate(messages):
            payload = json.loads(msg.payload.decode("utf-8"))
            assert payload["index"] == i

    async def test_multiple_transports_same_queue(self):
        """Multiple VirtualTransports sharing a queue interleave correctly.

        In the real system, multiple players on the same Room_Stream share
        a single send_queue. Messages from different players should all
        arrive in the queue in the order they were sent.
        """
        send_queue: asyncio.Queue = asyncio.Queue()
        transport_a = VirtualTransport("player-a", "ROOM01", send_queue)
        transport_b = VirtualTransport("player-b", "ROOM01", send_queue)

        # Alternate sending from both transports
        for i in range(100):
            await transport_a.send_json({"from": "a", "seq": i})
            await transport_b.send_json({"from": "b", "seq": i})

        # Should have 200 messages total
        assert send_queue.qsize() == 200

        # Verify interleaving pattern: a0, b0, a1, b1, ...
        for i in range(100):
            msg_a = send_queue.get_nowait()
            payload_a = json.loads(msg_a.payload.decode("utf-8"))
            assert payload_a["from"] == "a"
            assert payload_a["seq"] == i
            assert msg_a.target_player_ids == ["player-a"]

            msg_b = send_queue.get_nowait()
            payload_b = json.loads(msg_b.payload.decode("utf-8"))
            assert payload_b["from"] == "b"
            assert payload_b["seq"] == i
            assert msg_b.target_player_ids == ["player-b"]

    async def test_rapid_messages_via_grpc_stream(self, stub):
        """Send many messages rapidly through a live gRPC stream.

        Verifies the Python worker processes a burst of messages without
        dropping any or crashing — the queue accumulates them correctly.
        """
        player_id = str(uuid.uuid4())

        # Create a room
        stream = stub.RoomStream()
        await stream.write(
            _make_game_message(player_id, "", "create_room", {"name": "BurstPlayer"})
        )
        msg = await _read_until_type(stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        room_code = payload["payload"]["room_code"]
        actual_player_id = payload["payload"]["player_id"]

        # Send a burst of reaction messages (lightweight, won't trigger game logic errors)
        burst_count = 50
        for i in range(burst_count):
            await stream.write(
                _make_game_message(
                    actual_player_id, room_code, "reaction", {"emoji": "🔥"}
                )
            )

        # Read back broadcast messages (reactions are broadcast to all in room)
        received_reactions = 0
        deadline = asyncio.get_event_loop().time() + 10.0
        while received_reactions < burst_count:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                msg = await asyncio.wait_for(stream.read(), timeout=remaining)
                if msg == grpc.aio.EOF:
                    break
                p = _decode_payload(msg)
                if p.get("type") == "reaction":
                    received_reactions += 1
            except asyncio.TimeoutError:
                break

        # We should receive all burst messages back as broadcasts
        assert received_reactions == burst_count

        await stream.done_writing()
