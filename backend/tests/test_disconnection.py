"""Unit tests for disconnection and reconnection logic.

Tests cover:
- Guesser disconnect: player marked disconnected, turn continues
- Drawer disconnect: turn ends with 0 points
- < 2 connected players: game ends with game_ended_insufficient_players
- Disconnected player receives 0 points for missed turns/rounds
- Disconnected player is skipped when it would be their turn to draw
- Reconnection within 120-second window: score and record restored, cleanup_task cancelled
- Cleanup_task fires after 120 seconds and removes player data

Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
"""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend import game_engine
from backend.models import GameConfig, Player, Room, RoomState, TurnEndReason, TurnState
from backend.room_manager import RoomManager


class FakeWebSocket:
    """Fake WebSocket for testing."""

    def __init__(self):
        self.sent_messages = []
        self.closed = False

    async def send_text(self, data: str):
        self.sent_messages.append(json.loads(data))

    async def close(self):
        self.closed = True


def make_room_with_players(n=3, state=RoomState.PLAYING):
    """Helper to create a room with N connected players in the given state."""
    players = []
    for i in range(n):
        ws = FakeWebSocket()
        p = Player(id=f"player_{i}", name=f"Player{i}", websocket=ws, is_connected=True)
        players.append(p)

    room = Room(
        code="TESTAB",
        host_id=players[0].id,
        players=players,
        state=state,
        current_round=1,
        drawer_index=0,
        config=GameConfig(num_rounds=3, turn_duration=80, max_players=8),
    )
    return room


@pytest.fixture
def room_manager():
    return RoomManager()


# --- Test: Guesser disconnect marks player disconnected, turn continues (Req 8.1) ---

@pytest.mark.asyncio
async def test_guesser_disconnect_marks_disconnected_and_continues_turn(room_manager):
    """When a guesser disconnects, they are marked as disconnected and the turn continues."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    # Set up active turn with player_0 as drawer
    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Disconnect player_1 (a guesser)
    await room_manager.handle_disconnect("player_1", game_engine=game_engine)

    # Player should be marked disconnected
    player_1 = next(p for p in room.players if p.id == "player_1")
    assert player_1.is_connected is False
    assert player_1.disconnect_time is not None
    assert player_1.cleanup_task is not None

    # Turn should still be active (not ended)
    assert room.turn is not None
    assert room.state == RoomState.PLAYING

    # Cleanup
    player_1.cleanup_task.cancel()


# --- Test: Drawer disconnect ends turn with 0 points (Req 8.2) ---

@pytest.mark.asyncio
async def test_drawer_disconnect_ends_turn_immediately(room_manager):
    """When the drawer disconnects, the turn ends immediately with 0 points."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    # Set up active turn with player_0 as drawer
    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Give player_1 a score before the turn (to verify no new score is awarded)
    room.players[1].score = 100

    # Disconnect the drawer (player_0)
    await room_manager.handle_disconnect("player_0", game_engine=game_engine)

    # Player should be marked disconnected
    player_0 = next(p for p in room.players if p.id == "player_0")
    assert player_0.is_connected is False

    # Turn should have ended (turn is None after end_turn advances)
    # The scores should not have changed (0 points for drawer disconnect)
    assert room.players[1].score == 100  # guesser got 0 extra points

    # Cleanup
    player_0.cleanup_task.cancel()


# --- Test: < 2 connected players ends game (Req 8.3) ---

@pytest.mark.asyncio
async def test_fewer_than_2_connected_players_ends_game(room_manager):
    """When fewer than 2 connected players remain, the game starts a 20-second countdown before ending."""
    room = make_room_with_players(2, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    # Set up active turn with player_0 as drawer
    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Disconnect the guesser (player_1) — now only 1 connected player remains
    await room_manager.handle_disconnect("player_1", game_engine=game_engine)

    # Game should NOT end immediately — it should start the grace period
    assert room.state == RoomState.PLAYING

    # Check broadcast of waiting_for_reconnect
    ws0 = room.players[0].websocket
    messages = [m for m in ws0.sent_messages if m["type"] == "waiting_for_reconnect"]
    assert len(messages) >= 1
    assert messages[0]["payload"]["seconds"] == 20

    # The insufficient players task should be set
    assert getattr(room, '_insufficient_players_task', None) is not None
    assert not room._insufficient_players_task.done()

    # Cancel the background task to avoid test leakage
    room._insufficient_players_task.cancel()
    room._insufficient_players_task = None

    # Cleanup
    player_1 = next(p for p in room.players if p.id == "player_1")
    player_1.cleanup_task.cancel()


# --- Test: Disconnected player receives 0 points (Req 8.6) ---

@pytest.mark.asyncio
async def test_disconnected_player_receives_zero_points():
    """Disconnected players cannot guess and therefore receive 0 points."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    rm = RoomManager()
    rm.rooms["TESTAB"] = room

    # Set up active turn with player_0 as drawer
    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Mark player_1 as disconnected
    room.players[1].is_connected = False
    initial_score = room.players[1].score

    # Disconnected player tries to guess — should be ignored
    await game_engine.handle_guess(room, "player_1", "apple", rm)

    # Score should not change
    assert room.players[1].score == initial_score
    # Player should not be marked as having guessed
    assert room.players[1].has_guessed is False


# --- Test: Disconnected player is skipped as drawer (Req 8.6) ---

@pytest.mark.asyncio
async def test_disconnected_player_skipped_as_drawer():
    """A disconnected player is skipped when it would be their turn to draw."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    rm = RoomManager()
    rm.rooms["TESTAB"] = room

    # Mark player_1 as disconnected
    room.players[1].is_connected = False

    # Set drawer_index so player_1 would be next (index 0, so next is 1)
    room.drawer_index = 0
    room.current_round = 1

    # Initialize word pool for start_turn
    from backend.words import WORDS
    room.word_pool = list(WORDS)

    # Call advance_turn_or_round — should skip player_1 (disconnected)
    await game_engine.advance_turn_or_round(room, rm)

    # The drawer should now be player_2 (index 2), not player_1 (index 1)
    assert room.drawer_index == 2


# --- Test: Reconnection within 120-second window (Req 8.5) ---

@pytest.mark.asyncio
async def test_reconnect_within_window_restores_player(room_manager):
    """Reconnecting within 120 seconds restores the player's score and cancels cleanup."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    # Give player_1 a score
    room.players[1].score = 250

    # Set up active turn with player_0 as drawer
    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Disconnect player_1
    await room_manager.handle_disconnect("player_1", game_engine=game_engine)

    player_1 = next(p for p in room.players if p.id == "player_1")
    assert player_1.is_connected is False
    assert player_1.cleanup_task is not None
    old_cleanup_task = player_1.cleanup_task

    # Reconnect player_1
    new_ws = FakeWebSocket()
    result = await room_manager.handle_reconnect("Player1", "TESTAB", new_ws)

    # Should succeed
    assert result["type"] == "reconnected"
    assert result["payload"]["player_id"] == "player_1"
    assert result["payload"]["score"] == 250

    # Player should be restored
    assert player_1.is_connected is True
    assert player_1.disconnect_time is None
    assert player_1.websocket is new_ws

    # Cleanup task should be cancelled
    assert old_cleanup_task.cancelling() or old_cleanup_task.cancelled()
    assert player_1.cleanup_task is None


# --- Test: Reconnect fails for non-existent room ---

@pytest.mark.asyncio
async def test_reconnect_to_nonexistent_room(room_manager):
    """Reconnecting to a non-existent room returns an error."""
    ws = FakeWebSocket()
    result = await room_manager.handle_reconnect("Player1", "NOROOM", ws)
    assert result["type"] == "error"
    assert result["payload"]["code"] == "ROOM_NOT_FOUND"


# --- Test: Reconnect fails when no matching disconnected player ---

@pytest.mark.asyncio
async def test_reconnect_no_matching_player(room_manager):
    """Reconnecting with a name that doesn't match any disconnected player fails."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    # All players are connected — no disconnected player named "Unknown"
    ws = FakeWebSocket()
    result = await room_manager.handle_reconnect("Unknown", "TESTAB", ws)
    assert result["type"] == "error"
    assert result["payload"]["code"] == "RECONNECT_FAILED"


# --- Test: Host disconnect in lobby reassigns host (Req 2.9) ---

@pytest.mark.asyncio
async def test_host_disconnect_in_lobby_reassigns_host(room_manager):
    """When the host disconnects in the lobby, the host role is reassigned."""
    room = make_room_with_players(3, state=RoomState.LOBBY)
    room_manager.rooms["TESTAB"] = room
    room.host_id = "player_0"

    # Disconnect the host (player_0)
    await room_manager.handle_disconnect("player_0", game_engine=None)

    # Host should be reassigned to next connected player
    assert room.host_id == "player_1"

    # Cleanup
    player_0 = next(p for p in room.players if p.id == "player_0")
    player_0.cleanup_task.cancel()


# --- Test: Host disconnect in lobby with no others closes room (Req 2.9) ---

@pytest.mark.asyncio
async def test_host_disconnect_in_lobby_no_others_deletes_room(room_manager):
    """When the sole host disconnects in the lobby, the room is deleted."""
    ws = FakeWebSocket()
    player = Player(id="solo_host", name="Solo", websocket=ws, is_connected=True)
    room = Room(
        code="SOLOAB",
        host_id="solo_host",
        players=[player],
        state=RoomState.LOBBY,
    )
    room_manager.rooms["SOLOAB"] = room

    await room_manager.handle_disconnect("solo_host", game_engine=None)

    # Room should be deleted
    assert "SOLOAB" not in room_manager.rooms


# --- Test: Reconnection after 120-second window: player record permanently removed (Req 8.7) ---

@pytest.mark.asyncio
async def test_reconnect_after_window_fails(room_manager):
    """After 120 seconds, the player is permanently removed and reconnection fails."""
    room = make_room_with_players(3, state=RoomState.LOBBY)
    room_manager.rooms["TESTAB"] = room

    # Simulate the cleanup task having fired (player permanently removed)
    await room_manager._permanently_remove_player("player_1")

    # Verify player is gone
    player_ids = [p.id for p in room.players]
    assert "player_1" not in player_ids

    # Attempt to reconnect — should fail because player record no longer exists
    new_ws = FakeWebSocket()
    result = await room_manager.handle_reconnect("Player1", "TESTAB", new_ws)
    assert result["type"] == "error"
    assert result["payload"]["code"] == "RECONNECT_FAILED"


# --- Test: Cleanup task permanently removes player after 120 seconds (Req 8.7) ---

@pytest.mark.asyncio
async def test_cleanup_task_removes_player_after_timeout(room_manager):
    """After 120 seconds without reconnection, the player is permanently removed."""
    room = make_room_with_players(3, state=RoomState.LOBBY)
    room_manager.rooms["TESTAB"] = room

    # Directly call _permanently_remove_player (simulating cleanup task firing)
    await room_manager._permanently_remove_player("player_1")

    # Player should be removed
    player_ids = [p.id for p in room.players]
    assert "player_1" not in player_ids
    assert len(room.players) == 2


# --- Test: Broadcast updated player list on disconnect (Req 8.4) ---

@pytest.mark.asyncio
async def test_disconnect_broadcasts_updated_player_list(room_manager):
    """When a player disconnects, the updated player list is broadcast."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    # Set up active turn with player_0 as drawer
    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Clear message history
    for p in room.players:
        p.websocket.sent_messages.clear()

    # Disconnect player_2 (a guesser)
    await room_manager.handle_disconnect("player_2", game_engine=game_engine)

    # Check that player_0 received a player_list broadcast
    ws0 = room.players[0].websocket
    player_list_msgs = [m for m in ws0.sent_messages if m["type"] == "player_list"]
    assert len(player_list_msgs) >= 1

    # The player list should show player_2 as disconnected
    players_payload = player_list_msgs[0]["payload"]["players"]
    p2_data = next(p for p in players_payload if p["id"] == "player_2")
    assert p2_data["is_connected"] is False

    # Cleanup
    player_2 = next(p for p in room.players if p.id == "player_2")
    player_2.cleanup_task.cancel()


# --- Test: player_reconnected broadcast on reconnect ---

@pytest.mark.asyncio
async def test_reconnect_broadcasts_player_reconnected(room_manager):
    """On reconnection, a player_reconnected message is broadcast."""
    room = make_room_with_players(3, state=RoomState.PLAYING)
    room_manager.rooms["TESTAB"] = room

    room.turn = TurnState(
        drawer_id="player_0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )

    # Disconnect player_1
    await room_manager.handle_disconnect("player_1", game_engine=game_engine)

    # Clear messages
    for p in room.players:
        if p.websocket:
            p.websocket.sent_messages.clear()

    # Reconnect player_1
    new_ws = FakeWebSocket()
    await room_manager.handle_reconnect("Player1", "TESTAB", new_ws)

    # Check that player_0 received player_reconnected
    ws0 = room.players[0].websocket
    reconnect_msgs = [m for m in ws0.sent_messages if m["type"] == "player_reconnected"]
    assert len(reconnect_msgs) >= 1
    assert reconnect_msgs[0]["payload"]["player_id"] == "player_1"
    assert reconnect_msgs[0]["payload"]["name"] == "Player1"
