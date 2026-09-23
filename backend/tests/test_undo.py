"""Tests for undo functionality."""

import pytest
import time
from unittest.mock import AsyncMock
from backend.models import Room, RoomState, Player, TurnState
from backend import ws_handler
from backend.ws_handler import room_manager


@pytest.mark.asyncio
async def test_undo_broadcasts_when_drawer_sends():
    """Verify that only the active drawer can broadcast undo."""
    room_code = "TEST01"
    drawer_id = "drawer-123"
    guesser_id = "guesser-456"

    drawer = Player(id=drawer_id, name="Drawer", is_connected=True)
    guesser = Player(id=guesser_id, name="Guesser", is_connected=True)

    room = Room(code=room_code, host_id=drawer_id)
    room.state = RoomState.PLAYING
    room.players = [drawer, guesser]
    room.players_by_id = {drawer_id: drawer, guesser_id: guesser}
    room.turn = TurnState(
        drawer_id=drawer_id,
        word="APPLE",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["APPLE", "BANANA", "CHERRY"],
    )

    room_manager.rooms[room_code] = room
    room_manager._player_to_room[drawer_id] = room_code
    room_manager._player_to_room[guesser_id] = room_code

    original_broadcast = room_manager.broadcast
    room_manager.broadcast = AsyncMock()

    try:
        mock_ws = AsyncMock()

        # 1. Drawer sends undo -> should broadcast
        await ws_handler._handle_local_message(mock_ws, drawer_id, "undo", {"action_id": 1})
        room_manager.broadcast.assert_awaited_once_with(
            room_code,
            {"type": "undo", "payload": {"action_id": 1}},
        )

        room_manager.broadcast.reset_mock()

        # 2. Guesser sends undo -> should NOT broadcast
        await ws_handler._handle_local_message(mock_ws, guesser_id, "undo", {"action_id": 2})
        room_manager.broadcast.assert_not_called()

    finally:
        room_manager.broadcast = original_broadcast
        room_manager.rooms.pop(room_code, None)
        room_manager._player_to_room.pop(drawer_id, None)
        room_manager._player_to_room.pop(guesser_id, None)

