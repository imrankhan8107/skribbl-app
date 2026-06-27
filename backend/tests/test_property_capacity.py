"""Property-based test for player capacity enforcement.

**Validates: Requirements 1.6, 1.7**

Property 2: Player capacity enforcement
For any room at maximum capacity, any subsequent join attempt SHALL be rejected
with a "room full" error, regardless of the requesting player's name or timing.
The hard cap is 12 players regardless of config.
"""

import pytest
from unittest.mock import AsyncMock

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.room_manager import RoomManager, MAX_PLAYERS_HARD_CAP


def make_mock_ws():
    """Factory for creating mock WebSocket instances."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


@given(st.integers(min_value=0, max_value=20))
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_player_capacity_enforcement(num_join_attempts):
    """Property 2: Player capacity enforcement.

    **Validates: Requirements 1.6, 1.7**

    For any number of join attempts (0–20), joins succeed up to max_players - 1
    (since the host counts as 1 player), and all joins beyond max_players are
    rejected with ROOM_FULL error. The hard cap is 12 regardless of config.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    room_code = create_result["payload"]["room_code"]

    # Use the default max_players (8) from GameConfig
    room = manager.get_room(room_code)
    effective_max = min(room.config.max_players, MAX_PLAYERS_HARD_CAP)

    # Host already occupies 1 slot, so remaining capacity is effective_max - 1
    remaining_capacity = effective_max - 1

    for i in range(num_join_attempts):
        ws = make_mock_ws()
        result = await manager.join_room(f"Player{i}", room_code, ws)

        if i < remaining_capacity:
            # Should succeed — room still has capacity
            assert result["type"] == "room_joined", (
                f"Join attempt {i} should succeed (capacity={effective_max}, "
                f"current players={i + 1} + host), but got: {result}"
            )
        else:
            # Should be rejected — room is full
            assert result["type"] == "error", (
                f"Join attempt {i} should be rejected (capacity={effective_max}, "
                f"current players={effective_max}), but got: {result}"
            )
            assert result["payload"]["code"] == "ROOM_FULL", (
                f"Expected ROOM_FULL error code, got: {result['payload']['code']}"
            )


@given(st.integers(min_value=0, max_value=20))
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_hard_cap_enforcement(num_join_attempts):
    """Property 2: Hard cap enforcement at 12 players.

    **Validates: Requirements 1.7**

    Even if config max_players is set above 12, the hard cap of 12 is enforced.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    room_code = create_result["payload"]["room_code"]

    # Set max_players above the hard cap to verify hard cap is enforced
    room = manager.get_room(room_code)
    room.config.max_players = 20  # Above hard cap of 12

    effective_max = min(room.config.max_players, MAX_PLAYERS_HARD_CAP)
    assert effective_max == MAX_PLAYERS_HARD_CAP  # Should be capped at 12

    remaining_capacity = effective_max - 1  # Host occupies 1 slot

    for i in range(num_join_attempts):
        ws = make_mock_ws()
        result = await manager.join_room(f"Player{i}", room_code, ws)

        if i < remaining_capacity:
            # Should succeed — room still has capacity
            assert result["type"] == "room_joined", (
                f"Join attempt {i} should succeed (hard cap={MAX_PLAYERS_HARD_CAP}, "
                f"current players={i + 1} + host), but got: {result}"
            )
        else:
            # Should be rejected — hard cap reached
            assert result["type"] == "error", (
                f"Join attempt {i} should be rejected (hard cap={MAX_PLAYERS_HARD_CAP}), "
                f"but got: {result}"
            )
            assert result["payload"]["code"] == "ROOM_FULL", (
                f"Expected ROOM_FULL error code, got: {result['payload']['code']}"
            )
