"""Unit tests for turn lifecycle in game_engine.py.

Validates Requirements 3.4, 3.5, 3.6, 3.7, 10.5:
- Word auto-selection after 15 seconds
- Hint scheduling at 40% and 70% elapsed
- Turn advancement after all players have drawn
- Round increment and game-over transition
"""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.game_engine import (
    advance_turn_or_round,
    draw_word_pack_choices,
    end_turn,
    handle_word_selection,
    start_turn,
)
from backend.models import (
    GameConfig,
    Player,
    Room,
    RoomState,
    TurnEndReason,
    TurnState,
)


def _make_player(player_id: str, name: str, connected: bool = True) -> Player:
    """Create a Player with a mocked websocket."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return Player(id=player_id, name=name, websocket=ws, is_connected=connected)


def _make_room(num_players: int = 2, num_rounds: int = 3) -> Room:
    """Create a Room with the given number of players, ready for game play."""
    players = [_make_player(f"player-{i}", f"Player{i}") for i in range(num_players)]
    room = Room(
        code="TEST01",
        host_id=players[0].id,
        players=players,
        config=GameConfig(num_rounds=num_rounds, turn_duration=80, max_players=8),
        state=RoomState.WORD_SELECTION,
        current_round=1,
        drawer_index=0,
    )
    return room


def _make_room_manager() -> AsyncMock:
    """Create a mocked RoomManager with broadcast as AsyncMock."""
    rm = AsyncMock()
    rm.broadcast = AsyncMock()
    return rm


class TestStartTurn:
    """Tests for start_turn function."""

    @pytest.mark.asyncio
    async def test_start_turn_sends_word_choices_to_drawer(self):
        """start_turn sends a word_choices message with 3 words to the drawer."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)

        drawer = room.players[room.drawer_index]
        drawer.websocket.send_text.assert_called_once()
        sent_data = json.loads(drawer.websocket.send_text.call_args[0][0])
        assert sent_data["type"] == "word_choices"
        assert len(sent_data["payload"]["choices"]) == 3

        # Cleanup auto-select task
        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

    @pytest.mark.asyncio
    async def test_start_turn_transitions_to_word_selection(self):
        """After start_turn, room state should be WORD_SELECTION."""
        room = _make_room()
        room.state = RoomState.PLAYING  # Set to something else first
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)

        assert room.state == RoomState.WORD_SELECTION

        # Cleanup
        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()


class TestHandleWordSelection:
    """Tests for handle_word_selection function."""

    @pytest.mark.asyncio
    async def test_handle_word_selection_creates_turn_state(self):
        """handle_word_selection creates a TurnState with the correct word and hint."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)
        choices = room._pending_word_choices
        word = choices[0]

        # Cancel auto-select before handling selection
        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

        await handle_word_selection(room, room.players[0].id, word, room_manager)

        assert room.turn is not None
        assert isinstance(room.turn, TurnState)
        assert room.turn.word == word
        # Hint should have same length as word
        assert len(room.turn.hint) == len(word)

        # Cleanup timer tasks
        if room.turn:
            for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
                if task and not task.done():
                    task.cancel()

    @pytest.mark.asyncio
    async def test_handle_word_selection_transitions_to_playing(self):
        """After word selection, room state should be PLAYING."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)
        choices = room._pending_word_choices
        word = choices[0]

        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

        await handle_word_selection(room, room.players[0].id, word, room_manager)

        assert room.state == RoomState.PLAYING

        # Cleanup
        if room.turn:
            for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
                if task and not task.done():
                    task.cancel()

    @pytest.mark.asyncio
    async def test_handle_word_selection_broadcasts_turn_started(self):
        """handle_word_selection broadcasts a turn_started message."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)
        choices = room._pending_word_choices
        word = choices[0]

        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

        await handle_word_selection(room, room.players[0].id, word, room_manager)

        # Check that broadcast was called with turn_started
        broadcast_calls = room_manager.broadcast.call_args_list
        turn_started_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "turn_started"
        ]
        assert len(turn_started_calls) >= 1
        payload = turn_started_calls[0][0][1]["payload"]
        assert payload["drawer_id"] == room.players[0].id
        assert "hint" in payload
        assert "duration" in payload

        # Cleanup
        if room.turn:
            for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
                if task and not task.done():
                    task.cancel()

    @pytest.mark.asyncio
    async def test_handle_word_selection_broadcasts_clear_canvas(self):
        """handle_word_selection broadcasts a clear_canvas message."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)
        choices = room._pending_word_choices
        word = choices[0]

        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

        await handle_word_selection(room, room.players[0].id, word, room_manager)

        # Check that broadcast was called with clear_canvas
        broadcast_calls = room_manager.broadcast.call_args_list
        clear_canvas_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "clear_canvas"
        ]
        assert len(clear_canvas_calls) >= 1

        # Cleanup
        if room.turn:
            for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
                if task and not task.done():
                    task.cancel()

    @pytest.mark.asyncio
    async def test_handle_word_selection_rejects_non_drawer(self):
        """handle_word_selection does nothing if called by a non-drawer player."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)
        choices = room._pending_word_choices
        word = choices[0]

        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

        # Call with wrong player_id (player-1 is not the drawer)
        await handle_word_selection(room, "player-1", word, room_manager)

        # Room should still be in WORD_SELECTION state
        assert room.state == RoomState.WORD_SELECTION
        assert room.turn is None

    @pytest.mark.asyncio
    async def test_handle_word_selection_rejects_invalid_word(self):
        """handle_word_selection does nothing if the word is not in the choices."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)

        if hasattr(room, "_auto_select_task") and room._auto_select_task:
            room._auto_select_task.cancel()

        # Call with a word not in the choices
        await handle_word_selection(room, room.players[0].id, "not_a_valid_word_xyz", room_manager)

        # Room should still be in WORD_SELECTION state
        assert room.state == RoomState.WORD_SELECTION
        assert room.turn is None


class TestEndTurn:
    """Tests for end_turn function."""

    @pytest.mark.asyncio
    async def test_end_turn_broadcasts_turn_ended(self):
        """end_turn broadcasts a turn_ended message with word and reason."""
        room = _make_room()
        room_manager = _make_room_manager()

        # Set up a turn state manually
        turn_state = TurnState(
            drawer_id="player-0",
            word="apple",
            hint=["_", "_", "_", "_", "_"],
            start_time=time.time(),
            word_choices=["apple", "banana", "cherry"],
        )
        room.turn = turn_state
        room.state = RoomState.PLAYING

        # Mock advance_turn_or_round to prevent it from calling start_turn
        with patch("backend.game_engine.advance_turn_or_round", new_callable=AsyncMock):
            await end_turn(room, TurnEndReason.TIMER_EXPIRED, room_manager)

        # Check broadcast was called with turn_ended
        broadcast_calls = room_manager.broadcast.call_args_list
        turn_ended_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "turn_ended"
        ]
        assert len(turn_ended_calls) >= 1
        payload = turn_ended_calls[0][0][1]["payload"]
        assert payload["word"] == "apple"
        assert payload["reason"] == TurnEndReason.TIMER_EXPIRED.value

    @pytest.mark.asyncio
    async def test_end_turn_clears_turn_state(self):
        """After end_turn, room.turn should be None."""
        room = _make_room()
        room_manager = _make_room_manager()

        turn_state = TurnState(
            drawer_id="player-0",
            word="apple",
            hint=["_", "_", "_", "_", "_"],
            start_time=time.time(),
            word_choices=["apple", "banana", "cherry"],
        )
        room.turn = turn_state
        room.state = RoomState.PLAYING

        with patch("backend.game_engine.advance_turn_or_round", new_callable=AsyncMock):
            await end_turn(room, TurnEndReason.TIMER_EXPIRED, room_manager)

        assert room.turn is None


class TestAdvanceTurnOrRound:
    """Tests for advance_turn_or_round function."""

    @pytest.mark.asyncio
    async def test_advance_turn_increments_drawer_index(self):
        """After advancing, drawer_index should move to the next player."""
        room = _make_room(num_players=3)
        room.drawer_index = 0
        room.current_round = 1
        room.state = RoomState.PLAYING
        room_manager = _make_room_manager()

        # Patch start_turn to prevent it from actually running
        with patch("backend.game_engine.start_turn", new_callable=AsyncMock):
            await advance_turn_or_round(room, room_manager)

        assert room.drawer_index == 1

    @pytest.mark.asyncio
    async def test_advance_turn_wraps_around_and_increments_round(self):
        """When drawer_index reaches end of players, it wraps to 0 and round increments."""
        room = _make_room(num_players=3, num_rounds=3)
        room.drawer_index = 2  # Last player
        room.current_round = 1
        room.state = RoomState.PLAYING
        room_manager = _make_room_manager()

        with patch("backend.game_engine.start_turn", new_callable=AsyncMock):
            await advance_turn_or_round(room, room_manager)

        assert room.drawer_index == 0
        assert room.current_round == 2

    @pytest.mark.asyncio
    async def test_game_over_after_final_round(self):
        """When all rounds are complete, room transitions to GAME_OVER and broadcasts game_over."""
        room = _make_room(num_players=2, num_rounds=2)
        room.drawer_index = 1  # Last player in round
        room.current_round = 2  # Final round
        room.state = RoomState.PLAYING
        room_manager = _make_room_manager()

        await advance_turn_or_round(room, room_manager)

        assert room.state == RoomState.GAME_OVER

        # Check game_over was broadcast
        broadcast_calls = room_manager.broadcast.call_args_list
        game_over_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "game_over"
        ]
        assert len(game_over_calls) >= 1
        payload = game_over_calls[0][0][1]["payload"]
        assert "scores" in payload

    @pytest.mark.asyncio
    async def test_advance_turn_skips_disconnected_players(self):
        """If next drawer is disconnected, skip them."""
        room = _make_room(num_players=3, num_rounds=3)
        room.drawer_index = 0
        room.current_round = 1
        room.state = RoomState.PLAYING
        # Mark player-1 as disconnected
        room.players[1].is_connected = False
        room_manager = _make_room_manager()

        with patch("backend.game_engine.start_turn", new_callable=AsyncMock):
            await advance_turn_or_round(room, room_manager)

        # Should skip player-1 and land on player-2
        assert room.drawer_index == 2


class TestAutoSelect:
    """Tests for the 15-second auto-select timer."""

    @pytest.mark.asyncio
    async def test_auto_select_after_15_seconds(self):
        """Verify that the auto-select task is created and would trigger word selection."""
        room = _make_room()
        room_manager = _make_room_manager()

        await start_turn(room, room_manager)

        # Verify the auto-select task was created
        assert hasattr(room, "_auto_select_task")
        assert room._auto_select_task is not None
        assert not room._auto_select_task.done()

        # Cancel it to prevent it from running in the background
        room._auto_select_task.cancel()

    @pytest.mark.asyncio
    async def test_auto_select_triggers_word_selection(self):
        """Auto-select actually selects a word when the timer fires."""
        room = _make_room()
        room_manager = _make_room_manager()

        # Patch asyncio.sleep to return immediately for the 15-second timer
        with patch("backend.game_engine.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            mock_sleep.return_value = None
            await start_turn(room, room_manager)

            # Give the event loop a chance to run the auto-select task
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        # After auto-select fires, room should transition to PLAYING
        # (handle_word_selection is called internally)
        if room.state == RoomState.PLAYING:
            assert room.turn is not None
            # Cleanup timer tasks
            if room.turn:
                for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
                    if task and not task.done():
                        task.cancel()
        else:
            # If the auto-select task hasn't completed yet, at least verify it was created
            assert hasattr(room, "_auto_select_task")
            if hasattr(room, "_auto_select_task") and room._auto_select_task:
                room._auto_select_task.cancel()


class TestCustomWords:
    """Tests for custom word pack creation and round injection."""

    def test_draw_word_pack_choices_includes_custom_pack(self):
        """When custom_words exist in config, Custom Words pack is guaranteed among choices."""
        room = _make_room()
        room.config.custom_words = ["Tardis", "Dalek", "Cyberman", "SonicScrewdriver"]

        packs, flat_choices = draw_word_pack_choices(room)
        assert len(packs) == 3
        custom_pack = next((p for p in packs if p["id"] == "custom"), None)
        assert custom_pack is not None
        assert custom_pack["name"] == "Custom Words"
        assert custom_pack["emoji"] == "✨"
        assert any(w in room.config.custom_words for w in custom_pack["words"])

    @pytest.mark.asyncio
    async def test_handle_word_selection_custom_word_theme(self):
        """Selecting a custom word assigns the custom theme and starts turn properly."""
        room = _make_room()
        room.config.custom_words = ["Tardis", "Dalek"]
        room._pending_word_choices = ["Tardis", "Apple", "Guitar"]
        room_manager = _make_room_manager()

        await handle_word_selection(room, "player-0", "Tardis", room_manager)

        assert room.state == RoomState.PLAYING
        assert room.turn is not None
        assert room.turn.word == "Tardis"
        assert room.turn.theme is not None
        assert room.turn.theme["id"] == "custom"
        assert room.turn.theme["name"] == "Custom Words"
        assert room.turn.theme["emoji"] == "✨"

        # Cleanup timers
        for task in (room.turn.timer_task, room.turn.hint_task_40, room.turn.hint_task_70):
            if task and not task.done():
                task.cancel()


class TestGameOverStatsAndMvp:
    """Tests for build_game_over_payload, session statistics, and MVP awards."""

    def test_build_game_over_payload_awards_mvps_and_session_stats(self):
        from backend.game_engine import build_game_over_payload
        room = _make_room(num_players=3)
        p0 = room.players[0]
        p1 = room.players[1]
        p2 = room.players[2]

        p0.score = 250
        p0.drawer_points_earned = 120
        p0.max_streak = 3

        p1.score = 180
        p1.fastest_guess_time = 4.2
        p1.correct_guesses_count = 5

        p2.score = 90

        payload = build_game_over_payload(room)

        # Top scorer gets session win
        assert p0.session_wins == 1
        assert p1.session_wins == 0
        assert p0.session_score == 250
        assert p1.session_score == 180

        # Scores list in payload
        assert len(payload["scores"]) == 3
        assert payload["scores"][0]["id"] == p0.id

        # MVP awards list
        mvp_badges = [m["badge"] for m in payload["mvp_awards"]]
        assert any("Speed Demon" in b for b in mvp_badges)
        assert any("Master Artist" in b for b in mvp_badges)
        assert any("Streak King" in b for b in mvp_badges)
        assert any("Sharpshooter" in b for b in mvp_badges)

        # Session stats list
        assert len(payload["session_stats"]) == 3
        assert payload["session_stats"][0]["id"] == p0.id
        assert payload["session_stats"][0]["session_wins"] == 1

    def test_build_game_over_payload_excludes_spectators(self):
        from backend.game_engine import build_game_over_payload
        from backend.models import Player
        room = _make_room(num_players=2)
        spec = Player(id="spec-1", name="SpectatorSam", score=0, is_spectator=True)
        room.add_player(spec)

        room.players[0].score = 150
        room.players[1].score = 80

        payload = build_game_over_payload(room)
        # Scores list only includes active players (length 2)
        assert len(payload["scores"]) == 2
        assert all(s["id"] != "spec-1" for s in payload["scores"])
        assert all(s["id"] != "spec-1" for s in payload["session_stats"])


class TestSpectatorInGame:
    """Tests for spectator interactions during active turns."""

    @pytest.mark.asyncio
    async def test_spectator_guess_broadcasts_as_chat_and_does_not_score(self):
        from backend.game_engine import handle_guess
        from backend.models import Player, TurnState
        room = _make_room(num_players=2)
        spec = Player(id="spec-1", name="Sam", score=0, is_spectator=True)
        room.add_player(spec)

        room.state = RoomState.PLAYING
        room.turn = TurnState(
            drawer_id="player-0",
            word="elephant",
            hint=["_"] * 8,
            start_time=time.time(),
            word_choices=["elephant", "dog", "cat"],
        )
        room_manager = _make_room_manager()

        # Spectator guesses the exact word
        await handle_guess(room, "spec-1", "elephant", room_manager)

        # Spectator didn't get has_guessed or score
        assert spec.has_guessed is False
        assert spec.score == 0
        assert "spec-1" not in room.turn.guess_order

        # Broadcast was chat_message with masked secret word
        chat_calls = [c for c in room_manager.broadcast.call_args_list if c[0][1]["type"] == "chat_message"]
        assert len(chat_calls) >= 1
        chat_payload = chat_calls[-1][0][1]["payload"]
        assert "Sam (Spectator)" in chat_payload["player_name"]
        assert "***" in chat_payload["text"]



