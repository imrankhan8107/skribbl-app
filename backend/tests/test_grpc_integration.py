"""End-to-end integration test for the gRPC multiplexing path.

Tests the full room lifecycle via gRPC bidirectional streaming:
  create_room → join_room → toggle_ready → start_game → word_choices

Uses an in-process gRPC server started via `start_grpc_server()` and connects
with a `grpc.aio` channel + stub. Exercises real game logic — no mocks.

Validates: Requirements 2.2, 4.1, 5.1
"""

import asyncio
import json
import uuid

import grpc
import grpc.aio
import pytest

from backend.grpc_server import start_grpc_server
from backend.proto.game_pb2 import GameMessage, BroadcastMessage
from backend.proto.game_pb2_grpc import GameServiceStub
from backend.ws_handler import room_manager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Use a dynamic port to avoid conflicts with other tests or running servers
_TEST_PORT = 50061


def _make_game_message(
    player_id: str, room_code: str, message_type: str, payload: dict | None = None
) -> GameMessage:
    """Construct a GameMessage protobuf (bare inner payload — test convenience)."""
    return GameMessage(
        player_id=player_id,
        room_code=room_code,
        message_type=message_type,
        payload=json.dumps(payload or {}).encode("utf-8"),
    )


def _make_gateway_message(
    player_id: str, room_code: str, message_type: str, payload: dict | None = None
) -> GameMessage:
    """Construct a GameMessage the way the REAL Go gateway does — the envelope
    payload is the FULL client message: {"type": ..., "payload": {...}}.

    The gRPC server must unwrap the inner payload before dispatching.
    """
    full_message = {"type": message_type, "payload": payload or {}}
    return GameMessage(
        player_id=player_id,
        room_code=room_code,
        message_type=message_type,
        payload=json.dumps(full_message).encode("utf-8"),
    )


def _decode_payload(msg: BroadcastMessage) -> dict:
    """Decode a BroadcastMessage's payload from bytes to dict."""
    return json.loads(msg.payload.decode("utf-8"))


async def _collect_messages(
    stream, *, timeout: float = 5.0, max_messages: int = 50
) -> list[BroadcastMessage]:
    """Read all available messages from a gRPC stream within the timeout."""
    messages: list[BroadcastMessage] = []
    try:
        async for msg in stream:
            messages.append(msg)
            if len(messages) >= max_messages:
                break
    except grpc.aio.AioRpcError:
        pass
    except asyncio.CancelledError:
        pass
    return messages


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


async def _read_until_type_for_player(
    stream,
    message_type: str,
    player_id: str,
    *,
    timeout: float = 10.0,
    max_messages: int = 50,
) -> BroadcastMessage:
    """Read messages targeted at a specific player until the desired type is found."""
    deadline = asyncio.get_event_loop().time() + timeout
    for _ in range(max_messages):
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            break
        try:
            msg = await asyncio.wait_for(stream.read(), timeout=remaining)
            if msg == grpc.aio.EOF:
                break
            # Check if this message is for our player (targeted or broadcast)
            targets = list(msg.target_player_ids)
            if targets and player_id not in targets:
                continue
            payload = _decode_payload(msg)
            if payload.get("type") == message_type:
                return msg
        except asyncio.TimeoutError:
            break
    raise AssertionError(
        f"Did not receive message of type '{message_type}' for player '{player_id}' "
        f"within {timeout}s"
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_rooms():
    """Reset room_manager state between tests for isolation."""
    room_manager.rooms.clear()
    room_manager._player_to_room.clear()
    yield
    room_manager.rooms.clear()
    room_manager._player_to_room.clear()


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
# Tests
# ---------------------------------------------------------------------------


class TestGRPCRoomLifecycle:
    """End-to-end room lifecycle: create → join → play → game starts via gRPC.

    Validates: Requirements 2.2, 4.1, 5.1
    """

    async def test_create_room_via_grpc(self, stub):
        """Player can create a room via gRPC and receive room_created response."""
        player_id = str(uuid.uuid4())

        # Open a bidirectional stream
        stream = stub.RoomStream()

        # Send create_room message
        await stream.write(
            _make_game_message(player_id, "", "create_room", {"name": "Alice"})
        )

        # Read the response — should be room_created
        msg = await _read_until_type(stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)

        assert payload["type"] == "room_created"
        assert "room_code" in payload["payload"]
        assert "player_id" in payload["payload"]
        assert len(payload["payload"]["room_code"]) == 6

        # Clean up
        await stream.done_writing()

    async def test_full_room_lifecycle_create_join_start(self, stub):
        """Full lifecycle: create_room → join_room → toggle_ready → start_game → word_choices.

        Exercises the full gRPC multiplexed path with two players on
        separate streams, verifying that broadcasts flow correctly.
        """
        host_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())

        # --- Host creates a room ---
        host_stream = stub.RoomStream()

        await host_stream.write(
            _make_game_message(host_id, "", "create_room", {"name": "Host"})
        )

        # Host receives room_created
        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "room_created"
        room_code = payload["payload"]["room_code"]
        actual_host_id = payload["payload"]["player_id"]
        assert len(room_code) == 6

        # --- Player 2 joins the room on a second stream ---
        player2_stream = stub.RoomStream()

        await player2_stream.write(
            _make_game_message(
                player2_id, room_code, "join_room", {"name": "Player2", "room_code": room_code}
            )
        )

        # Player 2 receives room_joined
        msg = await _read_until_type(player2_stream, "room_joined", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "room_joined"
        assert payload["payload"]["room_code"] == room_code
        actual_player2_id = payload["payload"]["player_id"]

        # Host should receive player_list broadcast showing 2 players
        msg = await _read_until_type(host_stream, "player_list", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "player_list"
        assert len(payload["payload"]["players"]) == 2

        # --- Both players toggle ready ---
        await host_stream.write(
            _make_game_message(actual_host_id, room_code, "toggle_ready", {})
        )
        # Host receives player_list broadcast (toggle_ready broadcasts player_list)
        msg = await _read_until_type(host_stream, "player_list", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "player_list"

        await player2_stream.write(
            _make_game_message(actual_player2_id, room_code, "toggle_ready", {})
        )
        # Player 2 receives player_list broadcast
        msg = await _read_until_type(player2_stream, "player_list", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "player_list"

        # --- Host starts the game ---
        await host_stream.write(
            _make_game_message(actual_host_id, room_code, "start_game", {})
        )

        # Both players should receive game_started
        msg = await _read_until_type(host_stream, "game_started", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "game_started"
        assert payload["payload"]["round"] == 1

        msg = await _read_until_type(player2_stream, "game_started", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "game_started"
        assert payload["payload"]["round"] == 1

        # The drawer (host, index 0) should receive word_choices
        msg = await _read_until_type(host_stream, "word_choices", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "word_choices"
        assert "choices" in payload["payload"]
        assert len(payload["payload"]["choices"]) == 3

        # Clean up
        await host_stream.done_writing()
        await player2_stream.done_writing()

    async def test_join_room_broadcasts_player_list(self, stub):
        """Joining a room broadcasts player_list to existing members via gRPC."""
        host_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())

        # Host creates a room
        host_stream = stub.RoomStream()
        await host_stream.write(
            _make_game_message(host_id, "", "create_room", {"name": "HostBroadcast"})
        )

        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        room_code = _decode_payload(msg)["payload"]["room_code"]

        # Player 2 joins
        player2_stream = stub.RoomStream()
        await player2_stream.write(
            _make_game_message(
                player2_id, room_code, "join_room", {"name": "Joiner", "room_code": room_code}
            )
        )

        # Player 2 gets room_joined
        msg = await _read_until_type(player2_stream, "room_joined", timeout=5.0)
        assert _decode_payload(msg)["type"] == "room_joined"

        # Host gets player_list with 2 players (broadcast through gRPC)
        msg = await _read_until_type(host_stream, "player_list", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "player_list"
        players = payload["payload"]["players"]
        assert len(players) == 2
        names = [p["name"] for p in players]
        assert "HostBroadcast" in names
        assert "Joiner" in names

        # Clean up
        await host_stream.done_writing()
        await player2_stream.done_writing()

    async def test_error_on_invalid_room_code(self, stub):
        """Joining a non-existent room returns an error via gRPC."""
        player_id = str(uuid.uuid4())

        stream = stub.RoomStream()
        await stream.write(
            _make_game_message(
                player_id, "BADCOD", "join_room", {"name": "Lost", "room_code": "BADCOD"}
            )
        )

        # Should receive an error message
        msg = await _read_until_type(stream, "error", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "error"
        assert payload["payload"]["code"] == "ROOM_NOT_FOUND"

        await stream.done_writing()

    async def test_messages_flow_through_multiplexed_path(self, stub):
        """Verify that messages from both players flow through a single gRPC path.

        This confirms the multiplexing design — each stream carries messages
        for its connected player, and broadcasts reach all players in the room.
        """
        host_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())

        # Host creates room
        host_stream = stub.RoomStream()
        await host_stream.write(
            _make_game_message(host_id, "", "create_room", {"name": "MuxHost"})
        )

        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        room_code = _decode_payload(msg)["payload"]["room_code"]
        actual_host_id = _decode_payload(msg)["payload"]["player_id"]

        # Player 2 joins on a separate stream
        player2_stream = stub.RoomStream()
        await player2_stream.write(
            _make_game_message(
                player2_id, room_code, "join_room", {"name": "MuxPlayer", "room_code": room_code}
            )
        )

        msg = await _read_until_type(player2_stream, "room_joined", timeout=5.0)
        actual_player2_id = _decode_payload(msg)["payload"]["player_id"]

        # Wait for host to get player_list
        msg = await _read_until_type(host_stream, "player_list", timeout=5.0)

        # Both toggle ready
        await host_stream.write(
            _make_game_message(actual_host_id, room_code, "toggle_ready", {})
        )
        # toggle_ready broadcasts player_list
        await _read_until_type(host_stream, "player_list", timeout=5.0)

        await player2_stream.write(
            _make_game_message(actual_player2_id, room_code, "toggle_ready", {})
        )
        await _read_until_type(player2_stream, "player_list", timeout=5.0)

        # Start game
        await host_stream.write(
            _make_game_message(actual_host_id, room_code, "start_game", {})
        )

        # Both receive game_started
        await _read_until_type(host_stream, "game_started", timeout=5.0)
        await _read_until_type(player2_stream, "game_started", timeout=5.0)

        # Host (drawer) gets word_choices
        msg = await _read_until_type(host_stream, "word_choices", timeout=5.0)
        choices = _decode_payload(msg)["payload"]["choices"]
        assert len(choices) == 3

        # Host selects a word
        await host_stream.write(
            _make_game_message(
                actual_host_id, room_code, "select_word", {"word": choices[0]}
            )
        )

        # Both players should receive turn_started (broadcast)
        msg = await _read_until_type(host_stream, "turn_started", timeout=5.0)
        host_turn = _decode_payload(msg)
        assert host_turn["type"] == "turn_started"
        assert host_turn["payload"]["drawer_id"] == actual_host_id

        msg = await _read_until_type(player2_stream, "turn_started", timeout=5.0)
        player2_turn = _decode_payload(msg)
        assert player2_turn["type"] == "turn_started"
        # Non-drawer should see hint with underscores
        assert "_" in player2_turn["payload"]["hint"]

        # Player 2 sends a stroke — should be broadcast (via "guess" for actual gameplay)
        # Let's test with a chat message in-game (incorrect guess)
        await player2_stream.write(
            _make_game_message(
                actual_player2_id, room_code, "guess", {"text": "wrongguess"}
            )
        )

        # Both should receive chat_message (incorrect guess broadcast)
        msg = await _read_until_type(player2_stream, "chat_message", timeout=5.0)
        chat_payload = _decode_payload(msg)
        assert chat_payload["payload"]["text"] == "wrongguess"

        msg = await _read_until_type(host_stream, "chat_message", timeout=5.0)
        chat_payload = _decode_payload(msg)
        assert chat_payload["payload"]["text"] == "wrongguess"

        # Clean up
        await host_stream.done_writing()
        await player2_stream.done_writing()


class TestGRPCGatewayMessageFormat:
    """Validate the gRPC server correctly unwraps the FULL client message
    envelope that the real Go gateway forwards ({"type": ..., "payload": {...}}).

    This is the format the actual gateway sends — distinct from the bare-payload
    format used by the other tests. It exercises the payload-unwrapping fix.

    Validates: Requirements 2.2, 4.1
    """

    async def test_create_room_with_gateway_format(self, stub):
        """create_room sent as a full gateway message extracts the name correctly."""
        player_id = str(uuid.uuid4())
        stream = stub.RoomStream()

        # Gateway-style: payload is the FULL client message
        await stream.write(
            _make_gateway_message(player_id, "", "create_room", {"name": "GatewayAlice"})
        )

        msg = await _read_until_type(stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "room_created"
        assert len(payload["payload"]["room_code"]) == 6

        await stream.done_writing()

    async def test_correct_guess_ends_turn_gateway_format(self, stub):
        """A CORRECT guess (gateway format) must be extracted and end the turn.

        This is the critical regression test: if the payload isn't unwrapped,
        the guess text is empty and the turn never ends via a correct guess.
        """
        host_id = str(uuid.uuid4())
        player2_id = str(uuid.uuid4())

        # Host creates room (gateway format)
        host_stream = stub.RoomStream()
        await host_stream.write(
            _make_gateway_message(host_id, "", "create_room", {"name": "GHost"})
        )
        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        room_code = _decode_payload(msg)["payload"]["room_code"]
        actual_host_id = _decode_payload(msg)["payload"]["player_id"]

        # Player 2 joins (gateway format)
        p2_stream = stub.RoomStream()
        await p2_stream.write(
            _make_gateway_message(
                player2_id, room_code, "join_room", {"name": "GGuesser", "room_code": room_code}
            )
        )
        msg = await _read_until_type(p2_stream, "room_joined", timeout=5.0)
        actual_p2_id = _decode_payload(msg)["payload"]["player_id"]

        await _read_until_type(host_stream, "player_list", timeout=5.0)

        # Ready up both (gateway format)
        await host_stream.write(_make_gateway_message(actual_host_id, room_code, "toggle_ready", {}))
        await _read_until_type(host_stream, "player_list", timeout=5.0)
        await p2_stream.write(_make_gateway_message(actual_p2_id, room_code, "toggle_ready", {}))
        await _read_until_type(p2_stream, "player_list", timeout=5.0)

        # Start game (gateway format)
        await host_stream.write(_make_gateway_message(actual_host_id, room_code, "start_game", {}))
        await _read_until_type(host_stream, "game_started", timeout=5.0)

        # Host (drawer) gets word_choices and selects the first word (gateway format)
        msg = await _read_until_type(host_stream, "word_choices", timeout=5.0)
        chosen_word = _decode_payload(msg)["payload"]["choices"][0]
        await host_stream.write(
            _make_gateway_message(actual_host_id, room_code, "select_word", {"word": chosen_word})
        )

        # Wait for turn_started on the guesser's stream
        await _read_until_type(p2_stream, "turn_started", timeout=5.0)

        # Player 2 submits the CORRECT word as a guess (gateway format)
        await p2_stream.write(
            _make_gateway_message(actual_p2_id, room_code, "guess", {"text": chosen_word})
        )

        # If the payload was unwrapped correctly, the guess matches → guess_correct.
        # If NOT unwrapped, the guess text is empty → no guess_correct → this times out.
        msg = await _read_until_type(p2_stream, "guess_correct", timeout=5.0)
        payload = _decode_payload(msg)
        assert payload["type"] == "guess_correct"
        assert payload["payload"]["player_name"] == "GGuesser"

        await host_stream.done_writing()
        await p2_stream.done_writing()

    @pytest.mark.asyncio
    async def test_grpc_transfer_host(self, stub):
        """Verify that transfer_host works via gRPC stream."""
        host_stream = stub.RoomStream()
        p2_stream = stub.RoomStream()

        # Host creates room
        host_create_msg = _make_gateway_message(
            player_id="temp_host",
            room_code="",
            message_type="create_room",
            payload={"name": "HostPlayer"},
        )
        await host_stream.write(host_create_msg)

        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        room_code = payload["payload"]["room_code"]
        actual_host_id = payload["payload"]["player_id"]

        # Player 2 joins room
        p2_join_msg = _make_gateway_message(
            player_id="temp_p2",
            room_code=room_code,
            message_type="join_room",
            payload={"name": "TargetPlayer", "room_code": room_code},
        )
        await p2_stream.write(p2_join_msg)

        msg = await _read_until_type(p2_stream, "room_joined", timeout=5.0)
        actual_p2_id = _decode_payload(msg)["payload"]["player_id"]

        # Drain join player_lists
        await _read_until_type(host_stream, "player_list", timeout=5.0)

        # Host transfers host role to Player 2
        transfer_msg = _make_gateway_message(
            actual_host_id, room_code, "transfer_host", {"target_player_id": actual_p2_id}
        )
        await host_stream.write(transfer_msg)

        # Host receives host_transferred confirmation
        msg = await _read_until_type(host_stream, "host_transferred", timeout=5.0)
        assert _decode_payload(msg)["payload"]["new_host_id"] == actual_p2_id

        # Player 2 receives host_changed event
        msg = await _read_until_type(p2_stream, "host_changed", timeout=5.0)
        assert _decode_payload(msg)["payload"]["new_host_id"] == actual_p2_id

        await host_stream.done_writing()
        await p2_stream.done_writing()

    @pytest.mark.asyncio
    async def test_grpc_mid_game_join_approval(self, stub):
        """Verify that mid-game join approval works seamlessly via gRPC streams."""
        host_stream = stub.RoomStream()
        p2_stream = stub.RoomStream()
        p3_stream = stub.RoomStream()

        # Host creates room
        await host_stream.write(_make_gateway_message(
            player_id="temp_host",
            room_code="",
            message_type="create_room",
            payload={"name": "HostPlayer"},
        ))
        msg = await _read_until_type(host_stream, "room_created", timeout=5.0)
        payload = _decode_payload(msg)
        room_code = payload["payload"]["room_code"]
        actual_host_id = payload["payload"]["player_id"]

        # Player 2 joins room
        await p2_stream.write(_make_gateway_message(
            player_id="temp_p2",
            room_code=room_code,
            message_type="join_room",
            payload={"name": "Player2", "room_code": room_code},
        ))
        msg = await _read_until_type(p2_stream, "room_joined", timeout=5.0)

        # Toggle ready and start game
        await host_stream.write(_make_gateway_message(actual_host_id, room_code, "toggle_ready", {}))
        await p2_stream.write(_make_gateway_message(
            _decode_payload(msg)["payload"]["player_id"], room_code, "toggle_ready", {}
        ))
        await host_stream.write(_make_gateway_message(actual_host_id, room_code, "start_game", {}))

        # Wait for game to enter word_selection/turn
        await _read_until_type(host_stream, "game_started", timeout=5.0)

        # Player 3 attempts to join mid-game
        await p3_stream.write(_make_gateway_message(
            player_id="temp_p3",
            room_code=room_code,
            message_type="join_room",
            payload={"name": "JoinerPlayer", "room_code": room_code},
        ))

        # Player 3 should receive join_request_pending
        msg = await _read_until_type(p3_stream, "join_request_pending", timeout=5.0)
        p3_pending = _decode_payload(msg)["payload"]
        req_id = p3_pending["request_id"]
        assert req_id != ""

        # Host should receive join_request_received
        msg = await _read_until_type(host_stream, "join_request_received", timeout=5.0)
        host_notif = _decode_payload(msg)["payload"]
        assert host_notif["request_id"] == req_id
        assert host_notif["player_name"] == "JoinerPlayer"

        # Host approves the join request as player
        await host_stream.write(_make_gateway_message(
            actual_host_id,
            room_code,
            "respond_join_request",
            {"request_id": req_id, "action": "accept_player"},
        ))

        # Host receives join_request_resolved
        msg = await _read_until_type(host_stream, "join_request_resolved", timeout=5.0)
        resolved = _decode_payload(msg)["payload"]
        assert resolved["request_id"] == req_id
        assert resolved["status"] == "accepted_player"

        # Player 3 receives room_joined
        msg = await _read_until_type(p3_stream, "room_joined", timeout=5.0)
        p3_joined = _decode_payload(msg)["payload"]
        assert p3_joined["room_code"] == room_code
        assert p3_joined["player_id"] != ""
        assert p3_joined["is_spectator"] is False

        await host_stream.done_writing()
        await p2_stream.done_writing()
        await p3_stream.done_writing()

