"""Property-based test for drawer bonus equals average of guesser scores.

**Validates: Requirements 7.2, 7.3**

Property 10: Drawer bonus equals average of guesser scores
For any turn that ends with at least one correct guess, the Drawer's bonus SHALL
equal round(mean(correct_guesser_scores)). For turns with zero correct guesses,
the Drawer's bonus SHALL be 0.
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.game_engine import compute_drawer_bonus


@given(st.lists(st.integers(min_value=45, max_value=750), min_size=1))
@settings(max_examples=200)
def test_drawer_bonus_equals_mean(scores):
    """Property 10: Drawer bonus equals mean of guesser scores.

    **Validates: Requirements 7.2, 7.3**

    For any non-empty list of scores in [50, 500], the drawer bonus equals
    round(sum(scores) / len(scores)).
    """
    expected = round(sum(scores) / len(scores))
    actual = compute_drawer_bonus(scores)
    assert actual == expected, (
        f"Expected drawer bonus {expected} for scores {scores}, got {actual}"
    )


@given(st.just([]))
@settings(max_examples=200)
def test_drawer_bonus_zero_for_empty(empty_list):
    """Property 10: Drawer bonus is 0 when no guessers scored.

    **Validates: Requirements 7.3**

    compute_drawer_bonus([]) always returns 0.
    """
    assert compute_drawer_bonus(empty_list) == 0, (
        "Expected drawer bonus to be 0 for empty guesser scores list"
    )
