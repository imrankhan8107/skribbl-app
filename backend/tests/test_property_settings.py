"""Property-based test for settings bounds enforcement.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 4: Settings bounds enforcement
For any settings update message, the server SHALL accept the value if and only if
it falls within the defined range (rounds: 2–10, duration: 30–180, max_players: 2–12);
out-of-range values SHALL be rejected with INVALID_SETTINGS error.
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


@given(st.integers(min_value=-100, max_value=100))
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_num_rounds_bounds(value):
    """Property 4: num_rounds bounds enforcement.

    **Validates: Requirements 2.1**

    For any integer value, update_settings with num_rounds SHALL accept
    if and only if 2 <= value <= 10.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    host_id = create_result["payload"]["player_id"]

    # Attempt to update num_rounds with the given value
    result = await manager.update_settings(host_id, {"num_rounds": value})

    if 2 <= value <= 10:
        # Value is in range — should be accepted
        assert result["type"] == "settings_updated", (
            f"num_rounds={value} is in range [2, 10] but was rejected: {result}"
        )
    else:
        # Value is out of range — should be rejected
        assert result["type"] == "error", (
            f"num_rounds={value} is out of range [2, 10] but was accepted: {result}"
        )
        assert result["payload"]["code"] == "INVALID_SETTINGS", (
            f"Expected INVALID_SETTINGS error code, got: {result['payload']['code']}"
        )


@given(st.integers(min_value=-100, max_value=300))
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_turn_duration_bounds(value):
    """Property 4: turn_duration bounds enforcement.

    **Validates: Requirements 2.2**

    For any integer value, update_settings with turn_duration SHALL accept
    if and only if 30 <= value <= 180.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    host_id = create_result["payload"]["player_id"]

    # Attempt to update turn_duration with the given value
    result = await manager.update_settings(host_id, {"turn_duration": value})

    if 30 <= value <= 180:
        # Value is in range — should be accepted
        assert result["type"] == "settings_updated", (
            f"turn_duration={value} is in range [30, 180] but was rejected: {result}"
        )
    else:
        # Value is out of range — should be rejected
        assert result["type"] == "error", (
            f"turn_duration={value} is out of range [30, 180] but was accepted: {result}"
        )
        assert result["payload"]["code"] == "INVALID_SETTINGS", (
            f"Expected INVALID_SETTINGS error code, got: {result['payload']['code']}"
        )


@given(st.integers(min_value=-100, max_value=100))
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_max_players_bounds(value):
    """Property 4: max_players bounds enforcement.

    **Validates: Requirements 2.3**

    For any integer value, update_settings with max_players SHALL accept
    if and only if 2 <= value <= 12.
    """
    manager = RoomManager()

    # Create a room with a host
    host_ws = make_mock_ws()
    create_result = await manager.create_room("Host", host_ws)
    assert create_result["type"] == "room_created"
    host_id = create_result["payload"]["player_id"]

    # Attempt to update max_players with the given value
    result = await manager.update_settings(host_id, {"max_players": value})

    if 2 <= value <= 12:
        # Value is in range — should be accepted
        assert result["type"] == "settings_updated", (
            f"max_players={value} is in range [2, 12] but was rejected: {result}"
        )
    else:
        # Value is out of range — should be rejected
        assert result["type"] == "error", (
            f"max_players={value} is out of range [2, 12] but was accepted: {result}"
        )
        assert result["payload"]["code"] == "INVALID_SETTINGS", (
            f"Expected INVALID_SETTINGS error code, got: {result['payload']['code']}"
        )
