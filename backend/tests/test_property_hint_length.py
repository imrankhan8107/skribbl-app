"""Property-based test for hint character count invariant.

**Validates: Requirements 4.1, 4.2, 4.3**

Property 8: For any hint update during a turn, the total number of characters
in the hint (underscores + revealed letters + spaces) SHALL equal the total
number of characters in the original word.
"""

from hypothesis import given, settings, assume
from hypothesis import strategies as st

from backend.game_engine import generate_initial_hint, reveal_hint_char


@settings(max_examples=200)
@given(
    word=st.text(min_size=1, alphabet=st.characters(blacklist_categories=('Cs',))),
    reveal_count=st.integers(min_value=0, max_value=20),
)
def test_hint_length_equals_word_length_at_every_step(word: str, reveal_count: int):
    """Hint length equals word length after initial generation and after every reveal step.

    **Validates: Requirements 4.1, 4.2, 4.3**
    """
    # Filter words that have at least 1 non-space character
    assume(any(c != ' ' for c in word))

    # Generate initial hint and assert length invariant
    hint = generate_initial_hint(word)
    assert len(hint) == len(word), (
        f"Initial hint length {len(hint)} != word length {len(word)}"
    )

    # Call reveal_hint_char N times, asserting length invariant after each call
    for step in range(reveal_count):
        hint = reveal_hint_char(hint, word)
        assert len(hint) == len(word), (
            f"Hint length {len(hint)} != word length {len(word)} after reveal step {step + 1}"
        )
