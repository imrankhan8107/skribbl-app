"""Property-based tests for guess case-insensitivity.

**Validates: Requirements 6.2**

Property 13: For any guess string and word string, the server SHALL treat
the guess as correct if and only if guess.strip().lower() == word.lower().
"""

import time
from unittest.mock import AsyncMock, patch

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from backend.game_engine import handle_guess
from backend.models import GameConfig, Player, Room, RoomState, TurnState


def _make_room_with_word(word: str) -> Room:
    """Create a Room in PLAYING state with an active turn using the given word."""
    drawer_ws = AsyncMock()
    drawer_ws.send_text = AsyncMock()
    guesser_ws = AsyncMock()
    guesser_ws.send_text = AsyncMock()

    drawer = Player(id="drawer-1", name="Drawer", websocket=drawer_ws, is_connected=True)
    guesser = Player(id="guesser-1", name="Guesser", websocket=guesser_ws, is_connected=True)

    room = Room(
        code="TEST01",
        host_id="drawer-1",
        players=[drawer, guesser],
        config=GameConfig(num_rounds=3, turn_duration=80, max_players=8),
        state=RoomState.PLAYING,
        current_round=1,
        drawer_index=0,
    )
    room.turn = TurnState(
        drawer_id="drawer-1",
        word=word,
        hint=["_"] * len(word),
        start_time=time.time(),
        word_choices=[word, "banana", "cherry"],
    )
    return room


@given(
    word=st.text(min_size=1, max_size=30),
    guess=st.text(min_size=1, max_size=30),
)
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_guess_case_insensitivity(word: str, guess: str):
    """Property 13: Guess case-insensitivity

    For any guess string and word string, the server SHALL treat the guess
    as correct if and only if guess.strip().lower() == word.lower().

    **Validates: Requirements 6.2**
    """
    # Filter out words that are empty after strip
    assume(len(word.strip()) > 0)

    room = _make_room_with_word(word)
    room_manager = AsyncMock()
    room_manager.broadcast = AsyncMock()

    # Patch end_turn to prevent side effects when all guessers guess correctly
    with patch("backend.game_engine.end_turn", new_callable=AsyncMock):
        await handle_guess(room, "guesser-1", guess, room_manager)

    player = room.players[1]
    expected_correct = guess.strip().lower() == word.lower()

    assert player.has_guessed == expected_correct, (
        f"Expected has_guessed={expected_correct} for word={word!r}, guess={guess!r}. "
        f"guess.strip().lower()={guess.strip().lower()!r}, word.lower()={word.lower()!r}"
    )
