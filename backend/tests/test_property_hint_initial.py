"""Property-based tests for hint initial state.

Validates: Requirements 3.3, 4.1
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.game_engine import generate_initial_hint


@given(word=st.text(min_size=1, alphabet=st.characters(blacklist_categories=('Cs',))))
@settings(max_examples=200)
def test_hint_initial_state(word: str):
    """Property 6: Hint initial state

    For any word assigned at the start of a turn, the initial hint broadcast
    to Guessers SHALL contain exactly the same number of characters as the word,
    with every non-space character replaced by an underscore and every space preserved.

    **Validates: Requirements 3.3, 4.1**
    """
    hint = generate_initial_hint(word)

    # Hint length must equal word length
    assert len(hint) == len(word)

    # For every position: spaces preserved, non-spaces are underscores
    for i in range(len(word)):
        if word[i] == ' ':
            assert hint[i] == ' ', f"Expected space at position {i}, got '{hint[i]}'"
        else:
            assert hint[i] == '_', f"Expected '_' at position {i}, got '{hint[i]}'"
