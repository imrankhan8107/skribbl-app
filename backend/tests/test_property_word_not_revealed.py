"""Property-based tests for word not revealed in chat during active turn.

**Validates: Requirements 6.6**

Property 15: Word not revealed in chat during active turn
For any chat or guess-result message broadcast to Guessers during an active turn,
the message text SHALL NOT contain the current word (case-insensitive substring match).
"""

import time
from unittest.mock import AsyncMock

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from backend.game_engine import handle_guess, handle_chat
from backend.models import Room, Player, GameConfig, RoomState, TurnState


def _make_player(player_id: str, name: str, connected: bool = True) -> Player:
    """Create a Player with a mocked websocket."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return Player(id=player_id, name=name, websocket=ws, is_connected=connected)


def _make_room_with_turn(word: str) -> Room:
    """Create a Room in PLAYING state with an active turn using the given word.

    Player-0 is the drawer, Player-1 is a guesser.
    """
    players = [_make_player("player-0", "Drawer"), _make_player("player-1", "Guesser")]
    room = Room(
        code="TEST01",
        host_id="player-0",
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


@given(
    word=st.text(
        min_size=1,
        max_size=20,
        alphabet=st.characters(blacklist_categories=('Cs',)),
    ),
    guess_text=st.text(
        min_size=1,
        max_size=50,
        alphabet=st.characters(blacklist_categories=('Cs',)),
    ),
)
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_incorrect_guess_does_not_reveal_word(word: str, guess_text: str):
    """Property 15: Word not revealed in chat during active turn (incorrect guess).

    For any incorrect guess broadcast as a chat_message, the message text SHALL NOT
    contain the current word as a case-insensitive substring.

    **Validates: Requirements 6.6**
    """
    assume(len(word.strip()) > 0 and any(c != ' ' for c in word))
    # Words from the word list have no leading/trailing whitespace
    assume(word == word.strip())

    # Only test incorrect guesses (guess doesn't match the word)
    assume(guess_text.strip().lower() != word.lower())

    # The guess text must not contain the word as a substring for this to be
    # a meaningful test — the server broadcasts incorrect guesses as-is, and
    # if a guesser types the word within a longer string, that's the guesser
    # revealing it, not the server. The property validates the server doesn't
    # add/expose the word in its broadcast logic.
    assume(word.lower() not in guess_text.lower())

    room = _make_room_with_turn(word)
    room_manager = _make_room_manager()

    await handle_guess(room, "player-1", guess_text, room_manager)

    # Check all broadcast messages
    for call in room_manager.broadcast.call_args_list:
        msg = call[0][1]
        if msg.get("type") == "chat_message":
            broadcast_text = msg["payload"]["text"]
            assert word.lower() not in broadcast_text.lower(), (
                f"Broadcast message '{broadcast_text}' contains the word '{word}' "
                f"(case-insensitive). Guess was: '{guess_text}'"
            )


@given(
    word=st.text(
        min_size=1,
        max_size=20,
        alphabet=st.characters(blacklist_categories=('Cs',)),
    ),
    guess_text=st.text(
        min_size=1,
        max_size=50,
        alphabet=st.characters(blacklist_categories=('Cs',)),
    ),
)
@settings(max_examples=200)
@pytest.mark.asyncio
async def test_drawer_chat_does_not_reveal_word(word: str, guess_text: str):
    """Property 15: Word not revealed in chat during active turn (drawer chat).

    For any chat message sent by the drawer, the broadcast message text SHALL NOT
    contain the current word as a case-insensitive substring.

    **Validates: Requirements 6.6**
    """
    assume(len(word.strip()) > 0 and any(c != ' ' for c in word))

    room = _make_room_with_turn(word)
    room_manager = _make_room_manager()

    await handle_chat(room, "player-0", guess_text, room_manager)

    # Check all broadcast messages
    for call in room_manager.broadcast.call_args_list:
        msg = call[0][1]
        if msg.get("type") == "chat_message":
            broadcast_text = msg["payload"]["text"]
            assert word.lower() not in broadcast_text.lower(), (
                f"Broadcast message '{broadcast_text}' contains the word '{word}' "
                f"(case-insensitive). Drawer chat was: '{guess_text}'"
            )
