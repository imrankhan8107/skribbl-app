"""Property-based tests for word uniqueness within a session.

**Validates: Requirements 10.2**
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.game_engine import draw_word_choices, select_word
from backend.models import Room
from backend.words import WORDS


@given(n=st.integers(min_value=1, max_value=200))
@settings(max_examples=200, deadline=None)
def test_word_uniqueness_within_session(n: int):
    """Property 12: Word uniqueness within a session

    For any game session, a word SHALL NOT be selected for a turn if it has
    already been used in that session, unless all words in the pool have been
    exhausted (at which point the pool is reshuffled and reused).

    **Validates: Requirements 10.2**
    """
    room = Room(code="ABCDEF", host_id="host-1")
    selected_words: list[str] = []

    for _ in range(n):
        choices = draw_word_choices(room)
        # Select the first word from the choices
        word = choices[0]
        select_word(room, word)
        selected_words.append(word)

    # As long as N <= len(WORDS), no word should repeat
    if n <= len(WORDS):
        assert len(selected_words) == len(set(selected_words)), (
            f"Duplicate word found within {n} turns (pool size: {len(WORDS)}). "
            f"Duplicates: {[w for w in selected_words if selected_words.count(w) > 1]}"
        )
    else:
        # If N > len(WORDS), the pool reshuffles — words may repeat after
        # that point, which is acceptable. We verify that the first
        # len(WORDS) selections are all unique.
        first_pool = selected_words[:len(WORDS)]
        assert len(first_pool) == len(set(first_pool)), (
            f"Duplicate word found within the first {len(WORDS)} turns before pool exhaustion."
        )
