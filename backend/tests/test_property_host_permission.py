"""Property-based test for host-only permission enforcement.

**Validates: Requirements 2.5, 9.5**

Property 5: Host-only permission enforcement
For any settings-change or start-game message, the server SHALL reject the request
with a permission error if and only if the sender is not the current Host of the room.
"""

import pytest
from unittest.mock import AsyncMock

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.room_manager import RoomManager


def make_mock_ws():
    """Factory for creating mock WebSocket instances."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


@given(st.booleans())
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_update_settings_host_permission(is_host):
    """Property 5: Host-only permission enforcement for update_settings.

    **Validates: Requirements 2.5**

    For any settings update, the host's request succeeds and a non-host's
    request is rejected with PERMISSION_DENIED.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    room_code = create_result["payload"]["room_code"]
    host_id = create_result["payload"]["player_id"]

    # Join a second player (non-host)
    non_host_ws = make_mock_ws()
    join_result = await manager.join_room("Player2", room_code, non_host_ws)
    assert join_result["type"] == "room_joined"
    non_host_id = join_result["payload"]["player_id"]

    # Choose sender based on the boolean
    sender_id = host_id if is_host else non_host_id

    # Attempt to update settings
    settings_dict = {"num_rounds": 5}
    result = await manager.update_settings(sender_id, settings_dict)

    if is_host:
        # Host's request should succeed
        assert result["type"] == "settings_updated", (
            f"Host's update_settings request should succeed, but got: {result}"
        )
    else:
        # Non-host's request should be rejected with PERMISSION_DENIED
        assert result["type"] == "error", (
            f"Non-host's update_settings request should be rejected, but got: {result}"
        )
        assert result["payload"]["code"] == "PERMISSION_DENIED", (
            f"Expected PERMISSION_DENIED error code, got: {result['payload']['code']}"
        )


@given(st.booleans())
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_start_game_host_permission(is_host):
    """Property 5: Host-only permission enforcement for start_game.

    **Validates: Requirements 2.5, 9.5**

    For start_game, the host's request succeeds (with 2+ players) and a
    non-host's request is rejected with PERMISSION_DENIED.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    room_code = create_result["payload"]["room_code"]
    host_id = create_result["payload"]["player_id"]

    # Join a second player (non-host) — needed for start_game to succeed
    non_host_ws = make_mock_ws()
    join_result = await manager.join_room("Player2", room_code, non_host_ws)
    assert join_result["type"] == "room_joined"
    non_host_id = join_result["payload"]["player_id"]

    # Choose sender based on the boolean
    sender_id = host_id if is_host else non_host_id

    # Attempt to start the game
    result = await manager.start_game(sender_id)

    if is_host:
        # Host's request should succeed (2 players present)
        assert result["type"] == "game_started", (
            f"Host's start_game request should succeed with 2 players, but got: {result}"
        )
    else:
        # Non-host's request should be rejected with PERMISSION_DENIED
        assert result["type"] == "error", (
            f"Non-host's start_game request should be rejected, but got: {result}"
        )
        assert result["payload"]["code"] == "PERMISSION_DENIED", (
            f"Expected PERMISSION_DENIED error code, got: {result['payload']['code']}"
        )
