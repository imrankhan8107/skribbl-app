"""Unit tests for rematch flow.

Tests cover:
- Score reset, round counter reset, state transition to LOBBY (Req 9.3, 9.4)
- Non-host rematch rejection (Req 9.5)
- Rematch from non-GAME_OVER state returns error

Requirements: 9.3, 9.4, 9.5
"""

import json

import pytest

from backend.models import GameConfig, Player, Room, RoomState
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


def make_game_over_room():
    """Create a room in GAME_OVER state with players having scores."""
    players = []
    for i in range(3):
        ws = FakeWebSocket()
        p = Player(
            id=f"player_{i}",
            name=f"Player{i}",
            websocket=ws,
            is_connected=True,
            score=(i + 1) * 100,  # 100, 200, 300
            has_guessed=True,
        )
        players.append(p)

    room = Room(
        code="REMTCH",
        host_id="player_0",
        players=players,
        state=RoomState.GAME_OVER,
        current_round=3,
        drawer_index=2,
        config=GameConfig(num_rounds=3, turn_duration=80, max_players=8),
        used_words={"apple", "banana", "cherry"},
        word_pool=["dog", "cat"],
    )
    return room


@pytest.fixture
def room_manager():
    rm = RoomManager()
    return rm


# --- Test: Host rematch resets all state and transitions to LOBBY (Req 9.3, 9.4) ---

@pytest.mark.asyncio
async def test_handle_rematch_resets_scores_and_state(room_manager):
    """After host calls handle_rematch in GAME_OVER state, all game state is reset."""
    room = make_game_over_room()
    room_manager.rooms["REMTCH"] = room

    result = await room_manager.handle_rematch("player_0")

    # Result type should be rematch_started
    assert result["type"] == "rematch_started"

    # All player scores reset to 0
    for player in room.players:
        assert player.score == 0

    # has_guessed reset to False
    for player in room.players:
        assert player.has_guessed is False

    # current_round reset to 0
    assert room.current_round == 0

    # drawer_index reset to 0
    assert room.drawer_index == 0

    # used_words cleared
    assert room.used_words == set()

    # word_pool cleared
    assert room.word_pool == []

    # Room state transitions to LOBBY
    assert room.state == RoomState.LOBBY


# --- Test: Rematch broadcasts rematch_started with player list and config (Req 9.4) ---

@pytest.mark.asyncio
async def test_handle_rematch_broadcasts_rematch_started(room_manager):
    """After rematch, a rematch_started message is broadcast with player list and config."""
    room = make_game_over_room()
    room_manager.rooms["REMTCH"] = room

    # Clear sent messages
    for p in room.players:
        p.websocket.sent_messages.clear()

    await room_manager.handle_rematch("player_0")

    # Check that all players received rematch_started broadcast
    for player in room.players:
        ws = player.websocket
        rematch_msgs = [m for m in ws.sent_messages if m["type"] == "rematch_started"]
        assert len(rematch_msgs) == 1

        payload = rematch_msgs[0]["payload"]
        # Should contain players list
        assert "players" in payload
        assert len(payload["players"]) == 3
        # All scores in broadcast should be 0
        for p_data in payload["players"]:
            assert p_data["score"] == 0

        # Should contain config
        assert "config" in payload
        assert payload["config"]["num_rounds"] == 3
        assert payload["config"]["turn_duration"] == 80
        assert payload["config"]["max_players"] == 8


# --- Test: Non-host rematch rejection (Req 9.5) ---

@pytest.mark.asyncio
async def test_handle_rematch_non_host_rejected(room_manager):
    """A non-host player attempting rematch receives PERMISSION_DENIED error."""
    room = make_game_over_room()
    room_manager.rooms["REMTCH"] = room

    # player_1 is not the host
    result = await room_manager.handle_rematch("player_1")

    assert result["type"] == "error"
    assert result["payload"]["code"] == "PERMISSION_DENIED"
    assert "host" in result["payload"]["message"].lower()

    # Room state should not have changed
    assert room.state == RoomState.GAME_OVER

    # Scores should not have changed
    assert room.players[0].score == 100
    assert room.players[1].score == 200
    assert room.players[2].score == 300


# --- Test: Rematch from non-GAME_OVER state returns error ---

@pytest.mark.asyncio
async def test_handle_rematch_from_non_game_over_state_returns_error(room_manager):
    """Calling handle_rematch from a non-GAME_OVER state returns an error."""
    # Test from LOBBY state
    room = make_game_over_room()
    room.state = RoomState.LOBBY
    room_manager.rooms["REMTCH"] = room

    result = await room_manager.handle_rematch("player_0")

    assert result["type"] == "error"
    assert result["payload"]["code"] == "GAME_NOT_ACTIVE"

    # Test from PLAYING state
    room.state = RoomState.PLAYING
    result = await room_manager.handle_rematch("player_0")

    assert result["type"] == "error"
    assert result["payload"]["code"] == "GAME_NOT_ACTIVE"

    # Test from WORD_SELECTION state
    room.state = RoomState.WORD_SELECTION
    result = await room_manager.handle_rematch("player_0")

    assert result["type"] == "error"
    assert result["payload"]["code"] == "GAME_NOT_ACTIVE"
