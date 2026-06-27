"""Unit tests for guess evaluation and chat handling in game_engine.py.

Validates Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8:
- Correct guess marks player as guessed and broadcasts guess_correct
- Incorrect guess broadcasts as chat_message
- Already-guessed player is silently ignored
- Drawer cannot guess
- All guessers correct triggers end_turn
- Chat from drawer strips the word
- Case-insensitive matching works
"""

import time
from unittest.mock import AsyncMock, patch

import pytest

from backend.game_engine import handle_chat, handle_guess
from backend.models import (
    GameConfig,
    Player,
    Room,
    RoomState,
    TurnState,
)


def _make_player(player_id: str, name: str, connected: bool = True) -> Player:
    """Create a Player with a mocked websocket."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return Player(id=player_id, name=name, websocket=ws, is_connected=connected)


def _make_room_with_turn(word: str = "apple", num_guessers: int = 2) -> Room:
    """Create a Room in PLAYING state with an active turn.

    Player-0 is the drawer, Player-1..N are guessers.
    """
    players = [_make_player(f"player-{i}", f"Player{i}") for i in range(num_guessers + 1)]
    room = Room(
        code="TEST01",
        host_id=players[0].id,
        players=players,
        config=GameConfig(num_rounds=3, turn_duration=80, max_players=8),
        state=RoomState.PLAYING,
        current_round=1,
        drawer_index=0,
    )
    room.turn = TurnState(
        drawer_id="player-0",
        word=word,
        hint=["_"] * len(word),
        start_time=time.time(),
        word_choices=[word, "banana", "cherry"],
    )
    return room


def _make_room_manager() -> AsyncMock:
    """Create a mocked RoomManager with broadcast as AsyncMock."""
    rm = AsyncMock()
    rm.broadcast = AsyncMock()
    return rm


class TestCorrectGuess:
    """Tests for correct guess handling."""

    @pytest.mark.asyncio
    async def test_correct_guess_marks_player_as_guessed(self):
        """A correct guess sets player.has_guessed = True."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "apple", room_manager)

        player = room.players[1]
        assert player.has_guessed is True

    @pytest.mark.asyncio
    async def test_correct_guess_broadcasts_guess_correct(self):
        """A correct guess broadcasts a guess_correct message with player_name."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "apple", room_manager)

        broadcast_calls = room_manager.broadcast.call_args_list
        guess_correct_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "guess_correct"
        ]
        assert len(guess_correct_calls) >= 1
        payload = guess_correct_calls[0][0][1]["payload"]
        assert payload["player_name"] == "Player1"
        # Word should NOT be in the payload
        assert "word" not in payload

    @pytest.mark.asyncio
    async def test_correct_guess_awards_score(self):
        """A correct guess awards a positive score to the player."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        initial_score = room.players[1].score
        await handle_guess(room, "player-1", "apple", room_manager)

        assert room.players[1].score > initial_score


class TestIncorrectGuess:
    """Tests for incorrect guess handling."""

    @pytest.mark.asyncio
    async def test_incorrect_guess_broadcasts_chat_message(self):
        """An incorrect guess is broadcast as a chat_message."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "banana", room_manager)

        broadcast_calls = room_manager.broadcast.call_args_list
        chat_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "chat_message"
        ]
        assert len(chat_calls) >= 1
        payload = chat_calls[0][0][1]["payload"]
        assert payload["player_name"] == "Player1"
        assert payload["text"] == "banana"
        assert payload["is_system"] is False

    @pytest.mark.asyncio
    async def test_incorrect_guess_does_not_mark_player(self):
        """An incorrect guess does not set has_guessed."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "banana", room_manager)

        assert room.players[1].has_guessed is False

    @pytest.mark.asyncio
    async def test_incorrect_guess_does_not_award_score(self):
        """An incorrect guess does not change the player's score."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "banana", room_manager)

        assert room.players[1].score == 0


class TestAlreadyGuessedPlayer:
    """Tests for already-guessed player lockout (Property 14)."""

    @pytest.mark.asyncio
    async def test_already_guessed_player_is_silently_ignored(self):
        """A player who already guessed correctly is silently ignored."""
        room = _make_room_with_turn("apple", num_guessers=2)
        room_manager = _make_room_manager()

        # Mark player-1 as already guessed
        room.players[1].has_guessed = True

        await handle_guess(room, "player-1", "apple", room_manager)

        # No broadcast should have been made
        room_manager.broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_already_guessed_player_score_unchanged(self):
        """A player who already guessed does not get additional score."""
        room = _make_room_with_turn("apple", num_guessers=2)
        room_manager = _make_room_manager()

        room.players[1].has_guessed = True
        room.players[1].score = 100

        await handle_guess(room, "player-1", "apple", room_manager)

        assert room.players[1].score == 100


class TestDrawerCannotGuess:
    """Tests that the drawer cannot submit guesses."""

    @pytest.mark.asyncio
    async def test_drawer_guess_is_ignored(self):
        """A guess from the drawer is silently ignored."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-0", "apple", room_manager)

        # No broadcast should have been made
        room_manager.broadcast.assert_not_called()
        # Drawer's has_guessed should remain False
        assert room.players[0].has_guessed is False


class TestAllGuessersCorrectEndsTurn:
    """Tests that the turn ends when all connected guessers guess correctly."""

    @pytest.mark.asyncio
    async def test_all_guessers_correct_triggers_end_turn(self):
        """When all connected guessers guess correctly, end_turn is called."""
        room = _make_room_with_turn("apple", num_guessers=2)
        room_manager = _make_room_manager()

        # First guesser guesses correctly
        room.players[1].has_guessed = True
        room.players[1]._guess_time = time.time()

        # Patch end_turn to verify it's called
        with patch("backend.game_engine.end_turn", new_callable=AsyncMock) as mock_end_turn:
            await handle_guess(room, "player-2", "apple", room_manager)

            mock_end_turn.assert_called_once()
            call_args = mock_end_turn.call_args[0]
            assert call_args[0] is room
            from backend.models import TurnEndReason
            assert call_args[1] == TurnEndReason.ALL_GUESSED

    @pytest.mark.asyncio
    async def test_not_all_guessers_does_not_end_turn(self):
        """When not all guessers have guessed, turn continues."""
        room = _make_room_with_turn("apple", num_guessers=2)
        room_manager = _make_room_manager()

        with patch("backend.game_engine.end_turn", new_callable=AsyncMock) as mock_end_turn:
            await handle_guess(room, "player-1", "apple", room_manager)

            # end_turn should NOT be called since player-2 hasn't guessed yet
            mock_end_turn.assert_not_called()

    @pytest.mark.asyncio
    async def test_disconnected_guesser_not_counted(self):
        """Disconnected guessers are not counted when checking if all guessed."""
        room = _make_room_with_turn("apple", num_guessers=2)
        room_manager = _make_room_manager()

        # Mark player-2 as disconnected
        room.players[2].is_connected = False

        # When player-1 guesses correctly, all *connected* guessers have guessed
        with patch("backend.game_engine.end_turn", new_callable=AsyncMock) as mock_end_turn:
            await handle_guess(room, "player-1", "apple", room_manager)

            mock_end_turn.assert_called_once()


class TestCaseInsensitiveMatching:
    """Tests for case-insensitive guess matching (Property 13)."""

    @pytest.mark.asyncio
    async def test_uppercase_guess_matches(self):
        """An uppercase guess matches a lowercase word."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "APPLE", room_manager)

        assert room.players[1].has_guessed is True

    @pytest.mark.asyncio
    async def test_mixed_case_guess_matches(self):
        """A mixed-case guess matches the word."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "ApPlE", room_manager)

        assert room.players[1].has_guessed is True

    @pytest.mark.asyncio
    async def test_whitespace_stripped_before_comparison(self):
        """Leading/trailing whitespace is stripped before comparison."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "  apple  ", room_manager)

        assert room.players[1].has_guessed is True

    @pytest.mark.asyncio
    async def test_partial_match_is_incorrect(self):
        """A partial match (substring) is not a correct guess."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "app", room_manager)

        assert room.players[1].has_guessed is False


class TestHandleChat:
    """Tests for handle_chat (drawer chat with word stripping)."""

    @pytest.mark.asyncio
    async def test_drawer_chat_broadcasts_message(self):
        """The drawer can send chat messages that are broadcast."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_chat(room, "player-0", "hello everyone", room_manager)

        broadcast_calls = room_manager.broadcast.call_args_list
        chat_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "chat_message"
        ]
        assert len(chat_calls) >= 1
        payload = chat_calls[0][0][1]["payload"]
        assert payload["player_name"] == "Player0"
        assert payload["text"] == "hello everyone"
        assert payload["is_system"] is False

    @pytest.mark.asyncio
    async def test_drawer_chat_strips_word(self):
        """The word is replaced with *** in the drawer's chat message."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_chat(room, "player-0", "the word is apple guys", room_manager)

        broadcast_calls = room_manager.broadcast.call_args_list
        chat_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "chat_message"
        ]
        assert len(chat_calls) >= 1
        payload = chat_calls[0][0][1]["payload"]
        assert "apple" not in payload["text"].lower()
        assert "***" in payload["text"]

    @pytest.mark.asyncio
    async def test_drawer_chat_strips_word_case_insensitive(self):
        """Word stripping is case-insensitive."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_chat(room, "player-0", "APPLE is the answer", room_manager)

        broadcast_calls = room_manager.broadcast.call_args_list
        chat_calls = [
            c for c in broadcast_calls
            if c[0][1].get("type") == "chat_message"
        ]
        assert len(chat_calls) >= 1
        payload = chat_calls[0][0][1]["payload"]
        assert "apple" not in payload["text"].lower()
        assert "***" in payload["text"]

    @pytest.mark.asyncio
    async def test_non_drawer_cannot_chat(self):
        """A non-drawer player's chat message is ignored."""
        room = _make_room_with_turn("apple")
        room_manager = _make_room_manager()

        await handle_chat(room, "player-1", "hello", room_manager)

        room_manager.broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_chat_ignored_when_no_active_turn(self):
        """Chat is ignored when there is no active turn."""
        room = _make_room_with_turn("apple")
        room.turn = None
        room_manager = _make_room_manager()

        await handle_chat(room, "player-0", "hello", room_manager)

        room_manager.broadcast.assert_not_called()


class TestGuessEdgeCases:
    """Edge case tests for guess handling."""

    @pytest.mark.asyncio
    async def test_guess_ignored_when_no_active_turn(self):
        """Guesses are ignored when there is no active turn."""
        room = _make_room_with_turn("apple")
        room.turn = None
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "apple", room_manager)

        room_manager.broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_guess_ignored_when_not_playing_state(self):
        """Guesses are ignored when room is not in PLAYING state."""
        room = _make_room_with_turn("apple")
        room.state = RoomState.LOBBY
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "apple", room_manager)

        room_manager.broadcast.assert_not_called()

    @pytest.mark.asyncio
    async def test_disconnected_player_cannot_guess(self):
        """A disconnected player's guess is ignored."""
        room = _make_room_with_turn("apple")
        room.players[1].is_connected = False
        room_manager = _make_room_manager()

        await handle_guess(room, "player-1", "apple", room_manager)

        room_manager.broadcast.assert_not_called()
        assert room.players[1].has_guessed is False
