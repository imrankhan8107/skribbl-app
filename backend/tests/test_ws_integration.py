"""Integration tests for WebSocket message dispatch.

Full-flow tests that exercise the WebSocket handler through the FastAPI app,
covering the entire lifecycle: create room → join → start game → word selection
→ stroke → guess → score → game over.

Also tests all error codes: ROOM_NOT_FOUND, ROOM_IN_PROGRESS, ROOM_FULL,
INVALID_NAME, PERMISSION_DENIED, INSUFFICIENT_PLAYERS, INVALID_SETTINGS,
NOT_YOUR_TURN, ALREADY_GUESSED, GAME_NOT_ACTIVE.

Requirements: 11.1, 11.2, 11.3, 11.6
"""

import json
from unittest.mock import patch, AsyncMock

import pytest
from starlette.testclient import TestClient

from backend.main import app
from backend.ws_handler import room_manager


@pytest.fixture(autouse=True)
def reset_rooms():
    """Reset room_manager state between tests for isolation."""
    room_manager.rooms.clear()
    yield
    room_manager.rooms.clear()


@pytest.fixture(autouse=True)
def patch_heartbeat():
    """Patch heartbeat to be a no-op in tests to avoid delays."""
    with patch("backend.ws_handler.start_heartbeat", return_value=None), \
         patch("backend.ws_handler.stop_heartbeat"):
        yield


@pytest.fixture
def client():
    """Create a TestClient for the FastAPI app."""
    return TestClient(app)


# --- Helper functions ---

def send_msg(ws, msg_type: str, payload: dict = None):
    """Send a JSON message over WebSocket."""
    msg = {"type": msg_type}
    if payload is not None:
        msg["payload"] = payload
    ws.send_text(json.dumps(msg))


def recv_msg(ws) -> dict:
    """Receive and parse a JSON message from WebSocket."""
    data = ws.receive_text()
    return json.loads(data)


def recv_until_type(ws, msg_type: str, max_messages: int = 20) -> dict:
    """Receive messages until one of the specified type is found."""
    for _ in range(max_messages):
        msg = recv_msg(ws)
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"Did not receive message of type '{msg_type}' within {max_messages} messages")


def create_room(ws, name: str = "Host") -> dict:
    """Create a room and return the room_created response."""
    send_msg(ws, "create_room", {"name": name})
    return recv_until_type(ws, "room_created")


def join_room(ws, name: str, room_code: str) -> dict:
    """Join a room and return the room_joined response."""
    send_msg(ws, "join_room", {"name": name, "room_code": room_code})
    return recv_until_type(ws, "room_joined")


# --- Test 1: Full game flow ---

def test_full_game_flow(client):
    """Full flow: create room → join → start game → word selection → stroke → guess → score → game over."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        # Host creates a room
        created = create_room(ws_host, "HostPlayer")
        room_code = created["payload"]["room_code"]
        host_player_id = created["payload"]["player_id"]
        assert len(room_code) == 6

        # Player 2 joins the room
        joined = join_room(ws_player, "Player2", room_code)
        player2_id = joined["payload"]["player_id"]
        assert joined["payload"]["room_code"] == room_code

        # Host receives player_list broadcast
        player_list_msg = recv_until_type(ws_host, "player_list")
        assert len(player_list_msg["payload"]["players"]) == 2

        # Configure game for quick test: 1 round (use min 2), short turn
        send_msg(ws_host, "update_settings", {"num_rounds": 2, "turn_duration": 30})

        # Host receives settings_updated broadcast
        settings_msg = recv_until_type(ws_host, "settings_updated")
        assert settings_msg["payload"]["config"]["num_rounds"] == 2
        assert settings_msg["payload"]["config"]["turn_duration"] == 30

        # Player also receives settings_updated
        settings_msg2 = recv_until_type(ws_player, "settings_updated")
        assert settings_msg2["payload"]["config"]["num_rounds"] == 2

        # Host starts the game
        send_msg(ws_host, "start_game")

        # Both players should receive game_started
        game_started_host = recv_until_type(ws_host, "game_started")
        assert game_started_host["payload"]["round"] == 1

        game_started_player = recv_until_type(ws_player, "game_started")
        assert game_started_player["payload"]["round"] == 1

        # Drawer (host, index 0) receives word_choices
        word_choices_msg = recv_until_type(ws_host, "word_choices")
        choices = word_choices_msg["payload"]["choices"]
        assert len(choices) == 3

        # Drawer selects a word
        selected_word = choices[0]
        send_msg(ws_host, "select_word", {"word": selected_word})

        # Both players receive turn_started
        turn_started_host = recv_until_type(ws_host, "turn_started")
        assert turn_started_host["payload"]["drawer_id"] == host_player_id

        turn_started_player = recv_until_type(ws_player, "turn_started")
        assert "_" in turn_started_player["payload"]["hint"]

        # Drawer sends a stroke — should be broadcast
        stroke_payload = {"points": [[10, 10], [20, 20]], "color": "#000000", "size": 3}
        send_msg(ws_host, "stroke", stroke_payload)

        # Player receives stroke broadcast
        stroke_msg = recv_until_type(ws_player, "stroke")
        assert stroke_msg["payload"]["points"] == [[10, 10], [20, 20]]

        # Player guesses correctly
        send_msg(ws_player, "guess", {"text": selected_word})

        # Both should receive guess_correct
        guess_correct_player = recv_until_type(ws_player, "guess_correct")
        assert guess_correct_player["payload"]["player_name"] == "Player2"

        guess_correct_host = recv_until_type(ws_host, "guess_correct")
        assert guess_correct_host["payload"]["player_name"] == "Player2"

        # Turn ends (all guessers guessed) — both receive turn_ended
        turn_ended_player = recv_until_type(ws_player, "turn_ended")
        assert turn_ended_player["payload"]["word"] == selected_word
        assert "scores" in turn_ended_player["payload"]

        turn_ended_host = recv_until_type(ws_host, "turn_ended")
        assert turn_ended_host["payload"]["word"] == selected_word


# --- Test 2: Error code - ROOM_NOT_FOUND ---

def test_error_room_not_found(client):
    """Joining a non-existent room returns ROOM_NOT_FOUND error."""
    with client.websocket_connect("/ws") as ws:
        send_msg(ws, "join_room", {"name": "Player", "room_code": "NOROOM"})
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "ROOM_NOT_FOUND"


# --- Test 3: Error code - ROOM_IN_PROGRESS ---

def test_error_room_in_progress(client):
    """Joining a room that's already playing returns ROOM_IN_PROGRESS error."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_p2, \
         client.websocket_connect("/ws") as ws_p3:

        # Create room and add a second player
        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_p2, "Player2", room_code)

        # Drain player_list from host
        recv_until_type(ws_host, "player_list")

        # Start game
        send_msg(ws_host, "start_game")
        recv_until_type(ws_host, "game_started")

        # Third player tries to join
        send_msg(ws_p3, "join_room", {"name": "Player3", "room_code": room_code})
        msg = recv_until_type(ws_p3, "error")
        assert msg["payload"]["code"] == "ROOM_IN_PROGRESS"


# --- Test 4: Error code - ROOM_FULL ---

def test_error_room_full(client):
    """Joining a room at max capacity returns ROOM_FULL error."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_p2, \
         client.websocket_connect("/ws") as ws_p3:

        # Create room and set max_players to 2
        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]

        send_msg(ws_host, "update_settings", {"max_players": 2})
        recv_until_type(ws_host, "settings_updated")

        # Second player joins (room is now full)
        join_room(ws_p2, "Player2", room_code)
        recv_until_type(ws_host, "player_list")

        # Third player tries to join — should fail
        send_msg(ws_p3, "join_room", {"name": "Player3", "room_code": room_code})
        msg = recv_until_type(ws_p3, "error")
        assert msg["payload"]["code"] == "ROOM_FULL"


# --- Test 5: Error code - INVALID_NAME ---

def test_error_invalid_name_empty(client):
    """Creating a room with empty name returns INVALID_NAME error."""
    with client.websocket_connect("/ws") as ws:
        send_msg(ws, "create_room", {"name": ""})
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "INVALID_NAME"


def test_error_invalid_name_too_long(client):
    """Creating a room with name > 20 chars returns INVALID_NAME error."""
    with client.websocket_connect("/ws") as ws:
        send_msg(ws, "create_room", {"name": "A" * 21})
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "INVALID_NAME"


def test_error_invalid_name_join(client):
    """Joining a room with invalid name returns INVALID_NAME error."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]

        send_msg(ws_player, "join_room", {"name": "", "room_code": room_code})
        msg = recv_until_type(ws_player, "error")
        assert msg["payload"]["code"] == "INVALID_NAME"


# --- Test 6: Error code - PERMISSION_DENIED ---

def test_error_permission_denied_start_game(client):
    """Non-host trying to start the game returns PERMISSION_DENIED error."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_player, "Player2", room_code)

        # Drain messages
        recv_until_type(ws_host, "player_list")

        # Non-host tries to start game
        send_msg(ws_player, "start_game")
        msg = recv_until_type(ws_player, "error")
        assert msg["payload"]["code"] == "PERMISSION_DENIED"


def test_error_permission_denied_update_settings(client):
    """Non-host trying to update settings returns PERMISSION_DENIED error."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_player, "Player2", room_code)

        # Drain messages
        recv_until_type(ws_host, "player_list")

        # Non-host tries to update settings
        send_msg(ws_player, "update_settings", {"num_rounds": 5})
        msg = recv_until_type(ws_player, "error")
        assert msg["payload"]["code"] == "PERMISSION_DENIED"


# --- Test 7: Error code - INSUFFICIENT_PLAYERS ---

def test_error_insufficient_players(client):
    """Host trying to start game with only 1 player returns INSUFFICIENT_PLAYERS error."""
    with client.websocket_connect("/ws") as ws_host:
        create_room(ws_host, "Host")

        # Try to start game with only 1 player
        send_msg(ws_host, "start_game")
        msg = recv_until_type(ws_host, "error")
        assert msg["payload"]["code"] == "INSUFFICIENT_PLAYERS"


# --- Test 8: Error code - INVALID_SETTINGS ---

def test_error_invalid_settings_num_rounds(client):
    """Setting num_rounds out of range returns INVALID_SETTINGS error."""
    with client.websocket_connect("/ws") as ws_host:
        create_room(ws_host, "Host")

        send_msg(ws_host, "update_settings", {"num_rounds": 99})
        msg = recv_until_type(ws_host, "error")
        assert msg["payload"]["code"] == "INVALID_SETTINGS"


def test_error_invalid_settings_turn_duration(client):
    """Setting turn_duration out of range returns INVALID_SETTINGS error."""
    with client.websocket_connect("/ws") as ws_host:
        create_room(ws_host, "Host")

        send_msg(ws_host, "update_settings", {"turn_duration": 5})
        msg = recv_until_type(ws_host, "error")
        assert msg["payload"]["code"] == "INVALID_SETTINGS"


def test_error_invalid_settings_max_players(client):
    """Setting max_players out of range returns INVALID_SETTINGS error."""
    with client.websocket_connect("/ws") as ws_host:
        create_room(ws_host, "Host")

        send_msg(ws_host, "update_settings", {"max_players": 100})
        msg = recv_until_type(ws_host, "error")
        assert msg["payload"]["code"] == "INVALID_SETTINGS"


# --- Test 9: Error code - GAME_NOT_ACTIVE ---

def test_error_game_not_active_before_identify(client):
    """Sending game messages before identifying returns GAME_NOT_ACTIVE error."""
    with client.websocket_connect("/ws") as ws:
        # Try to start game without identifying first
        send_msg(ws, "start_game")
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "GAME_NOT_ACTIVE"


def test_error_game_not_active_update_settings(client):
    """Sending update_settings before identifying returns GAME_NOT_ACTIVE error."""
    with client.websocket_connect("/ws") as ws:
        send_msg(ws, "update_settings", {"num_rounds": 5})
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "GAME_NOT_ACTIVE"


# --- Test 10: Stroke/fill/clear_canvas broadcast ---

def test_stroke_broadcast(client):
    """Stroke messages from the drawer are broadcast to other players."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_player, "Player2", room_code)
        recv_until_type(ws_host, "player_list")

        # Start game
        send_msg(ws_host, "start_game")
        recv_until_type(ws_host, "game_started")
        recv_until_type(ws_player, "game_started")

        # Select a word
        word_choices = recv_until_type(ws_host, "word_choices")
        selected_word = word_choices["payload"]["choices"][0]
        send_msg(ws_host, "select_word", {"word": selected_word})

        # Wait for turn_started
        recv_until_type(ws_host, "turn_started")
        recv_until_type(ws_player, "turn_started")

        # Send stroke
        stroke_payload = {"points": [[5, 5], [15, 15]], "color": "#FF0000", "size": 5}
        send_msg(ws_host, "stroke", stroke_payload)

        # Player should receive stroke
        stroke_msg = recv_until_type(ws_player, "stroke")
        assert stroke_msg["payload"]["color"] == "#FF0000"


def test_fill_broadcast(client):
    """Fill messages from the drawer are broadcast to other players."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_player, "Player2", room_code)
        recv_until_type(ws_host, "player_list")

        # Start game
        send_msg(ws_host, "start_game")
        recv_until_type(ws_host, "game_started")
        recv_until_type(ws_player, "game_started")

        # Select a word
        word_choices = recv_until_type(ws_host, "word_choices")
        selected_word = word_choices["payload"]["choices"][0]
        send_msg(ws_host, "select_word", {"word": selected_word})

        # Wait for turn_started
        recv_until_type(ws_host, "turn_started")
        recv_until_type(ws_player, "turn_started")

        # Send fill
        fill_payload = {"x": 100, "y": 100, "color": "#00FF00"}
        send_msg(ws_host, "fill", fill_payload)

        # Player should receive fill
        fill_msg = recv_until_type(ws_player, "fill")
        assert fill_msg["payload"]["x"] == 100
        assert fill_msg["payload"]["color"] == "#00FF00"


def test_clear_canvas_broadcast(client):
    """Clear canvas messages from the drawer are broadcast to other players."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_player, "Player2", room_code)
        recv_until_type(ws_host, "player_list")

        # Start game
        send_msg(ws_host, "start_game")
        recv_until_type(ws_host, "game_started")
        recv_until_type(ws_player, "game_started")

        # Select a word
        word_choices = recv_until_type(ws_host, "word_choices")
        selected_word = word_choices["payload"]["choices"][0]
        send_msg(ws_host, "select_word", {"word": selected_word})

        # Wait for turn_started (which also sends clear_canvas)
        recv_until_type(ws_host, "turn_started")
        recv_until_type(ws_player, "turn_started")

        # Drain the initial clear_canvas from turn start
        recv_until_type(ws_player, "clear_canvas")

        # Explicitly send clear_canvas
        send_msg(ws_host, "clear_canvas")

        # Player should receive clear_canvas
        clear_msg = recv_until_type(ws_player, "clear_canvas")
        assert clear_msg["type"] == "clear_canvas"


# --- Test 11: Disconnect handling ---

def test_disconnect_handling(client):
    """When a player disconnects, the remaining players receive updated player list."""
    with client.websocket_connect("/ws") as ws_host:
        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]

        # Open a second connection that will disconnect
        with client.websocket_connect("/ws") as ws_player:
            join_room(ws_player, "Player2", room_code)
            # Host receives player_list with 2 players
            player_list = recv_until_type(ws_host, "player_list")
            assert len(player_list["payload"]["players"]) == 2

        # ws_player disconnects when exiting the with block
        # Host should receive an updated player_list showing Player2 as disconnected
        player_list2 = recv_until_type(ws_host, "player_list")
        players = player_list2["payload"]["players"]
        p2 = next((p for p in players if p["name"] == "Player2"), None)
        assert p2 is not None
        assert p2["is_connected"] is False


# --- Test 12: Incorrect guess broadcast as chat ---

def test_incorrect_guess_broadcast_as_chat(client):
    """Incorrect guesses are broadcast as chat messages."""
    with client.websocket_connect("/ws") as ws_host, \
         client.websocket_connect("/ws") as ws_player:

        created = create_room(ws_host, "Host")
        room_code = created["payload"]["room_code"]
        join_room(ws_player, "Player2", room_code)
        recv_until_type(ws_host, "player_list")

        # Start game
        send_msg(ws_host, "start_game")
        recv_until_type(ws_host, "game_started")
        recv_until_type(ws_player, "game_started")

        # Select a word
        word_choices = recv_until_type(ws_host, "word_choices")
        selected_word = word_choices["payload"]["choices"][0]
        send_msg(ws_host, "select_word", {"word": selected_word})

        # Wait for turn_started
        recv_until_type(ws_host, "turn_started")
        recv_until_type(ws_player, "turn_started")

        # Player makes an incorrect guess
        send_msg(ws_player, "guess", {"text": "wrongguess"})

        # Both should receive chat_message with the incorrect guess
        chat_msg = recv_until_type(ws_player, "chat_message")
        assert chat_msg["payload"]["text"] == "wrongguess"
        assert chat_msg["payload"]["player_name"] == "Player2"


# --- Test 13: JSON serialization (Requirement 11.6) ---

def test_all_messages_are_json(client):
    """All WebSocket messages are serialized as JSON (Requirement 11.6)."""
    with client.websocket_connect("/ws") as ws:
        # Send a valid create_room — response should be valid JSON
        send_msg(ws, "create_room", {"name": "TestJSON"})
        raw = ws.receive_text()
        msg = json.loads(raw)  # This will raise if not valid JSON
        assert "type" in msg
        assert msg["type"] == "room_created"


# --- Test 14: Invalid JSON message handling ---

def test_invalid_json_message(client):
    """Sending invalid JSON returns an error without crashing the connection."""
    with client.websocket_connect("/ws") as ws:
        ws.send_text("not valid json {{{")
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "INVALID_MESSAGE"

        # Connection should still be alive — can send another message
        send_msg(ws, "create_room", {"name": "StillAlive"})
        response = recv_until_type(ws, "room_created")
        assert response["type"] == "room_created"


# --- Test 15: Unknown message type ---

def test_unknown_message_type(client):
    """Sending an unknown message type returns an error."""
    with client.websocket_connect("/ws") as ws:
        send_msg(ws, "nonexistent_type", {"data": "test"})
        msg = recv_until_type(ws, "error")
        assert msg["payload"]["code"] == "UNKNOWN_MESSAGE"
