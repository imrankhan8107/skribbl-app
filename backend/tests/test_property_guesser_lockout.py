"""Property-based test for correct guesser lockout.

**Validates: Requirements 6.4**

Property 14: Correct guesser lockout
For any player who has already guessed correctly in the current turn, any subsequent
guess message from that player SHALL be silently ignored (no score awarded, no chat broadcast).
"""

import time
from unittest.mock import AsyncMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from backend.game_engine import handle_guess
from backend.models import (
    GameConfig,
    Player,
    Room,
    RoomState,
    TurnState,
)


def _make_player(player_id: str, name: str) -> Player:
    """Create a Player with a mocked websocket."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return Player(id=player_id, name=name, websocket=ws, is_connected=True)


def _make_room_with_active_turn() -> Room:
    """Create a Room in PLAYING state with an active turn (word = 'apple').

    Player-0 is the drawer, Player-1 is the guesser.
    """
    drawer = _make_player("player-0", "Drawer")
    guesser = _make_player("player-1", "Guesser")
    room = Room(
        code="TEST01",
        host_id=drawer.id,
        players=[drawer, guesser],
        config=GameConfig(num_rounds=3, turn_duration=80, max_players=8),
        state=RoomState.PLAYING,
        current_round=1,
        drawer_index=0,
    )
    room.turn = TurnState(
        drawer_id="player-0",
        word="apple",
        hint=["_", "_", "_", "_", "_"],
        start_time=time.time(),
        word_choices=["apple", "banana", "cherry"],
    )
    return room


@pytest.mark.asyncio
@given(num_additional_guesses=st.integers(min_value=1, max_value=10))
@settings(max_examples=200)
async def test_correct_guesser_lockout(num_additional_guesses: int):
    """Property 14: Correct guesser lockout.

    **Validates: Requirements 6.4**

    Simulate a player guessing correctly then submitting additional guesses;
    assert subsequent guesses are silently ignored (no score change, no broadcast).
    """
    room = _make_room_with_active_turn()
    room_manager = AsyncMock()
    room_manager.broadcast = AsyncMock()

    # Step 1: Have the guesser submit the correct guess ("apple") — this should succeed
    await handle_guess(room, "player-1", "apple", room_manager)

    # Verify the correct guess was accepted
    guesser = room.players[1]
    assert guesser.has_guessed is True

    # Step 2: Record the player's score after the correct guess
    score_after_correct_guess = guesser.score
    assert score_after_correct_guess > 0  # Score should have been awarded

    # Step 3: Reset broadcast mock to track only subsequent calls
    room_manager.broadcast.reset_mock()

    # Step 4: Submit N additional guesses (alternating correct "apple" and incorrect "banana")
    for i in range(num_additional_guesses):
        guess_text = "apple" if i % 2 == 0 else "banana"
        await handle_guess(room, "player-1", guess_text, room_manager)

    # Step 5: Assert player's score hasn't changed after the additional guesses
    assert guesser.score == score_after_correct_guess, (
        f"Score changed from {score_after_correct_guess} to {guesser.score} "
        f"after {num_additional_guesses} additional guesses (should be silently ignored)"
    )

    # Step 6: Assert room_manager.broadcast was NOT called for any of the additional guesses
    room_manager.broadcast.assert_not_called(), (
        f"Broadcast was called {room_manager.broadcast.call_count} times "
        f"for additional guesses after correct guess (should be silently ignored)"
    )
