"""Property-based tests for hint never fully reveals the word.

Validates: Requirements 4.5
"""

from hypothesis import given, settings, assume
from hypothesis import strategies as st

from backend.game_engine import generate_initial_hint, reveal_hint_char


@given(
    word=st.text(min_size=1, alphabet=st.characters(blacklist_categories=('Cs',))),
    reveal_count=st.integers(min_value=0, max_value=50),
)
@settings(max_examples=200)
def test_hint_never_fully_reveals_word(word: str, reveal_count: int):
    """Property 7: Hint never fully reveals the word

    For any word and any number of reveal operations (less than the number of
    non-space characters), the hint SHALL always contain at least one underscore
    — i.e., at least one character remains hidden until the turn ends.

    **Validates: Requirements 4.5**
    """
    # Word must have at least 1 non-space character
    assume(any(c != ' ' for c in word))

    hint = generate_initial_hint(word)

    # Apply reveal_hint_char up to reveal_count times
    for _ in range(reveal_count):
        hint = reveal_hint_char(hint, word)

    # At least one underscore must always remain
    assert '_' in hint, (
        f"Hint fully revealed the word '{word}' after {reveal_count} reveals: {hint}"
    )
