"""Unit tests for RoomManager."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from backend.models import RoomState
from backend.room_manager import RoomManager


@pytest.fixture
def manager():
    return RoomManager()


@pytest.fixture
def mock_ws():
    """Create a mock WebSocket with send_text method."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


def make_mock_ws():
    """Factory for creating mock WebSocket instances."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


class TestRoomCodeGeneration:
    """Tests for room code generation."""

    async def test_room_code_is_6_chars(self, manager, mock_ws):
        result = await manager.create_room("Alice", mock_ws)
        room_code = result["payload"]["room_code"]
        assert len(room_code) == 6

    async def test_room_code_is_uppercase_alphanumeric(self, manager, mock_ws):
        result = await manager.create_room("Alice", mock_ws)
        room_code = result["payload"]["room_code"]
        assert room_code.isalnum()
        assert room_code == room_code.upper()

    async def test_room_codes_are_unique(self, manager):
        codes = set()
        for i in range(50):
            ws = make_mock_ws()
            result = await manager.create_room(f"Player{i}", ws)
            codes.add(result["payload"]["room_code"])
        assert len(codes) == 50


class TestCreateRoom:
    """Tests for create_room."""

    async def test_create_room_success(self, manager, mock_ws):
        result = await manager.create_room("Alice", mock_ws)
        assert result["type"] == "room_created"
        assert "room_code" in result["payload"]
        assert "player_id" in result["payload"]
        assert "config" in result["payload"]

    async def test_create_room_assigns_host(self, manager, mock_ws):
        result = await manager.create_room("Alice", mock_ws)
        room_code = result["payload"]["room_code"]
        player_id = result["payload"]["player_id"]
        room = manager.get_room(room_code)
        assert room.host_id == player_id

    async def test_create_room_player_in_room(self, manager, mock_ws):
        result = await manager.create_room("Alice", mock_ws)
        room_code = result["payload"]["room_code"]
        room = manager.get_room(room_code)
        assert len(room.players) == 1
        assert room.players[0].name == "Alice"

    async def test_create_room_default_config(self, manager, mock_ws):
        result = await manager.create_room("Alice", mock_ws)
        config = result["payload"]["config"]
        assert config["num_rounds"] == 3
        assert config["turn_duration"] == 80
        assert config["max_players"] == 8

    async def test_create_room_invalid_name_empty(self, manager, mock_ws):
        result = await manager.create_room("", mock_ws)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "INVALID_NAME"

    async def test_create_room_invalid_name_too_long(self, manager, mock_ws):
        result = await manager.create_room("A" * 21, mock_ws)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "INVALID_NAME"

    async def test_create_room_valid_name_1_char(self, manager, mock_ws):
        result = await manager.create_room("A", mock_ws)
        assert result["type"] == "room_created"

    async def test_create_room_valid_name_20_chars(self, manager, mock_ws):
        result = await manager.create_room("A" * 20, mock_ws)
        assert result["type"] == "room_created"


class TestJoinRoom:
    """Tests for join_room."""

    async def test_join_room_success(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        join_result = await manager.join_room("Bob", room_code, ws2)
        assert join_result["type"] == "room_joined"
        assert join_result["payload"]["room_code"] == room_code
        assert len(join_result["payload"]["players"]) == 2

    async def test_join_room_not_found(self, manager, mock_ws):
        result = await manager.join_room("Bob", "XXXXXX", mock_ws)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "ROOM_NOT_FOUND"

    async def test_join_room_in_progress(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        # Manually set room state to PLAYING
        room = manager.get_room(room_code)
        room.state = RoomState.PLAYING

        result = await manager.join_room("Bob", room_code, ws2)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "ROOM_IN_PROGRESS"

    async def test_join_room_full(self, manager):
        ws_host = make_mock_ws()
        create_result = await manager.create_room("Host", ws_host)
        room_code = create_result["payload"]["room_code"]

        # Set max_players to 2 for easy testing
        room = manager.get_room(room_code)
        room.config.max_players = 2

        # Add one more player to fill the room
        ws2 = make_mock_ws()
        await manager.join_room("Player2", room_code, ws2)

        # Try to add a third player
        ws3 = make_mock_ws()
        result = await manager.join_room("Player3", room_code, ws3)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "ROOM_FULL"

    async def test_join_room_hard_cap_12(self, manager):
        ws_host = make_mock_ws()
        create_result = await manager.create_room("Host", ws_host)
        room_code = create_result["payload"]["room_code"]

        # Set max_players to 12 (hard cap)
        room = manager.get_room(room_code)
        room.config.max_players = 12

        # Fill room to 12 players
        for i in range(11):
            ws = make_mock_ws()
            await manager.join_room(f"Player{i}", room_code, ws)

        # 13th player should be rejected
        ws_extra = make_mock_ws()
        result = await manager.join_room("Extra", room_code, ws_extra)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "ROOM_FULL"

    async def test_join_room_invalid_name(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        result = await manager.join_room("", room_code, ws2)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "INVALID_NAME"

    async def test_join_room_broadcasts_player_list(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        await manager.join_room("Bob", room_code, ws2)

        # Host should have received a player_list broadcast
        ws1.send_text.assert_called()
        import json
        call_data = json.loads(ws1.send_text.call_args[0][0])
        assert call_data["type"] == "player_list"
        assert len(call_data["payload"]["players"]) == 2


class TestRemovePlayer:
    """Tests for remove_player."""

    async def test_remove_player_from_room(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        join_result = await manager.join_room("Bob", room_code, ws2)
        bob_id = join_result["payload"]["player_id"]

        await manager.remove_player(bob_id)
        room = manager.get_room(room_code)
        assert len(room.players) == 1
        assert room.players[0].name == "Alice"

    async def test_remove_host_reassigns(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        alice_id = create_result["payload"]["player_id"]

        join_result = await manager.join_room("Bob", room_code, ws2)
        bob_id = join_result["payload"]["player_id"]

        await manager.remove_player(alice_id)
        room = manager.get_room(room_code)
        assert room.host_id == bob_id

    async def test_remove_last_player_deletes_room(self, manager):
        ws1 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        alice_id = create_result["payload"]["player_id"]

        await manager.remove_player(alice_id)
        assert manager.get_room(room_code) is None

    async def test_remove_nonexistent_player(self, manager):
        # Should not raise
        await manager.remove_player("nonexistent-id")

    async def test_remove_player_broadcasts_updated_list(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        join_result = await manager.join_room("Bob", room_code, ws2)
        bob_id = join_result["payload"]["player_id"]

        # Reset mock call history
        ws1.send_text.reset_mock()

        await manager.remove_player(bob_id)

        # Alice should receive updated player list
        ws1.send_text.assert_called()
        import json
        call_data = json.loads(ws1.send_text.call_args[0][0])
        assert call_data["type"] == "player_list"
        assert len(call_data["payload"]["players"]) == 1


class TestBroadcast:
    """Tests for broadcast."""

    async def test_broadcast_sends_to_all_connected(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        await manager.join_room("Bob", room_code, ws2)

        # Reset mocks
        ws1.send_text.reset_mock()
        ws2.send_text.reset_mock()

        message = {"type": "test", "payload": {"data": "hello"}}
        await manager.broadcast(room_code, message)

        ws1.send_text.assert_called_once()
        ws2.send_text.assert_called_once()

    async def test_broadcast_nonexistent_room(self, manager):
        # Should not raise
        await manager.broadcast("XXXXXX", {"type": "test"})

    async def test_broadcast_skips_disconnected_players(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        await manager.join_room("Bob", room_code, ws2)

        # Mark Bob as disconnected
        room = manager.get_room(room_code)
        room.players[1].is_connected = False

        ws1.send_text.reset_mock()
        ws2.send_text.reset_mock()

        await manager.broadcast(room_code, {"type": "test"})

        ws1.send_text.assert_called_once()
        ws2.send_text.assert_not_called()


class TestUpdateSettings:
    """Tests for update_settings."""

    async def test_update_num_rounds_success(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"num_rounds": 5})
        assert update_result["type"] == "settings_updated"
        assert update_result["payload"]["config"]["num_rounds"] == 5

    async def test_update_turn_duration_success(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"turn_duration": 120})
        assert update_result["type"] == "settings_updated"
        assert update_result["payload"]["config"]["turn_duration"] == 120

    async def test_update_max_players_success(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"max_players": 10})
        assert update_result["type"] == "settings_updated"
        assert update_result["payload"]["config"]["max_players"] == 10

    async def test_update_multiple_settings(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(
            player_id, {"num_rounds": 7, "turn_duration": 60, "max_players": 4}
        )
        assert update_result["type"] == "settings_updated"
        config = update_result["payload"]["config"]
        assert config["num_rounds"] == 7
        assert config["turn_duration"] == 60
        assert config["max_players"] == 4

    async def test_update_settings_non_host_rejected(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        join_result = await manager.join_room("Bob", room_code, ws2)
        bob_id = join_result["payload"]["player_id"]

        result = await manager.update_settings(bob_id, {"num_rounds": 5})
        assert result["type"] == "error"
        assert result["payload"]["code"] == "PERMISSION_DENIED"

    async def test_update_settings_not_in_lobby(self, manager):
        ws = make_mock_ws()
        create_result = await manager.create_room("Alice", ws)
        player_id = create_result["payload"]["player_id"]
        room_code = create_result["payload"]["room_code"]

        # Manually set room state to PLAYING
        room = manager.get_room(room_code)
        room.state = RoomState.PLAYING

        result = await manager.update_settings(player_id, {"num_rounds": 5})
        assert result["type"] == "error"
        assert result["payload"]["code"] == "GAME_NOT_ACTIVE"

    async def test_update_num_rounds_below_min(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"num_rounds": 1})
        assert update_result["type"] == "error"
        assert update_result["payload"]["code"] == "INVALID_SETTINGS"

    async def test_update_num_rounds_above_max(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"num_rounds": 11})
        assert update_result["type"] == "error"
        assert update_result["payload"]["code"] == "INVALID_SETTINGS"

    async def test_update_turn_duration_below_min(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"turn_duration": 29})
        assert update_result["type"] == "error"
        assert update_result["payload"]["code"] == "INVALID_SETTINGS"

    async def test_update_turn_duration_above_max(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"turn_duration": 181})
        assert update_result["type"] == "error"
        assert update_result["payload"]["code"] == "INVALID_SETTINGS"

    async def test_update_max_players_below_min(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"max_players": 1})
        assert update_result["type"] == "error"
        assert update_result["payload"]["code"] == "INVALID_SETTINGS"

    async def test_update_max_players_above_max(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        update_result = await manager.update_settings(player_id, {"max_players": 13})
        assert update_result["type"] == "error"
        assert update_result["payload"]["code"] == "INVALID_SETTINGS"

    async def test_update_settings_boundary_values_accepted(self, manager):
        ws = make_mock_ws()
        result = await manager.create_room("Alice", ws)
        player_id = result["payload"]["player_id"]

        # Test min boundary values
        update_result = await manager.update_settings(
            player_id, {"num_rounds": 2, "turn_duration": 30, "max_players": 2}
        )
        assert update_result["type"] == "settings_updated"

        # Test max boundary values
        update_result = await manager.update_settings(
            player_id, {"num_rounds": 10, "turn_duration": 180, "max_players": 12}
        )
        assert update_result["type"] == "settings_updated"

    async def test_update_settings_broadcasts_to_all(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)

        # Reset mocks
        ws1.send_text.reset_mock()
        ws2.send_text.reset_mock()

        await manager.update_settings(player_id, {"num_rounds": 5})

        # Both players should receive the broadcast
        import json
        ws1.send_text.assert_called_once()
        ws2.send_text.assert_called_once()
        data = json.loads(ws1.send_text.call_args[0][0])
        assert data["type"] == "settings_updated"
        assert data["payload"]["config"]["num_rounds"] == 5

    async def test_update_settings_player_not_in_room(self, manager):
        result = await manager.update_settings("nonexistent-id", {"num_rounds": 5})
        assert result["type"] == "error"
        assert result["payload"]["code"] == "GAME_NOT_ACTIVE"


class TestStartGame:
    """Tests for start_game."""

    async def test_start_game_success(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)

        result = await manager.start_game(player_id)
        assert result["type"] == "game_started"
        assert result["payload"]["round"] == 1
        assert result["payload"]["total_rounds"] == 3
        assert "drawer_id" in result["payload"]

    async def test_start_game_transitions_to_word_selection(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)
        await manager.start_game(player_id)

        room = manager.get_room(room_code)
        assert room.state == RoomState.WORD_SELECTION

    async def test_start_game_non_host_rejected(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]

        join_result = await manager.join_room("Bob", room_code, ws2)
        bob_id = join_result["payload"]["player_id"]

        result = await manager.start_game(bob_id)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "PERMISSION_DENIED"

    async def test_start_game_insufficient_players(self, manager):
        ws = make_mock_ws()
        create_result = await manager.create_room("Alice", ws)
        player_id = create_result["payload"]["player_id"]

        result = await manager.start_game(player_id)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "INSUFFICIENT_PLAYERS"

    async def test_start_game_not_in_lobby(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)

        # Manually set room state to PLAYING
        room = manager.get_room(room_code)
        room.state = RoomState.PLAYING

        result = await manager.start_game(player_id)
        assert result["type"] == "error"
        assert result["payload"]["code"] == "GAME_NOT_ACTIVE"

    async def test_start_game_first_player_is_drawer(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)

        result = await manager.start_game(player_id)
        room = manager.get_room(room_code)
        assert result["payload"]["drawer_id"] == room.players[0].id

    async def test_start_game_broadcasts_to_all(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)

        # Reset mocks
        ws1.send_text.reset_mock()
        ws2.send_text.reset_mock()

        await manager.start_game(player_id)

        import json
        ws1.send_text.assert_called_once()
        ws2.send_text.assert_called_once()
        data = json.loads(ws1.send_text.call_args[0][0])
        assert data["type"] == "game_started"

    async def test_start_game_player_not_in_room(self, manager):
        result = await manager.start_game("nonexistent-id")
        assert result["type"] == "error"
        assert result["payload"]["code"] == "GAME_NOT_ACTIVE"

    async def test_start_game_uses_configured_rounds(self, manager):
        ws1 = make_mock_ws()
        ws2 = make_mock_ws()
        create_result = await manager.create_room("Alice", ws1)
        room_code = create_result["payload"]["room_code"]
        player_id = create_result["payload"]["player_id"]

        await manager.join_room("Bob", room_code, ws2)

        # Update rounds setting
        await manager.update_settings(player_id, {"num_rounds": 7})

        result = await manager.start_game(player_id)
        assert result["payload"]["total_rounds"] == 7
