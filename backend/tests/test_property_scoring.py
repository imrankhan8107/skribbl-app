"""Property-based tests for correct guess scoring formula.

Validates: Requirements 7.1
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.game_engine import compute_guesser_score


FIXED_DURATION = 80


@given(ratio=st.floats(min_value=0, max_value=1, allow_nan=False))
@settings(max_examples=200)
def test_score_always_in_range(ratio: float):
    """Property 9: Correct guess scoring formula — score always in [45, 750]

    For any correct guess at elapsed ratio in [0, 1], the awarded score
    SHALL be in the range [45, 750] (min=50*0.9 position multiplier, max=500*1.5 first guesser).

    **Validates: Requirements 7.1**
    """
    elapsed = ratio * FIXED_DURATION
    # Test all positions
    for position in [1, 2, 3, 4]:
        score = compute_guesser_score(elapsed, FIXED_DURATION, position)
        assert 45 <= score <= 750, (
            f"Score {score} out of range [45, 750] for ratio={ratio}, position={position}"
        )


@given(
    r1=st.floats(min_value=0, max_value=1, allow_nan=False),
    r2=st.floats(min_value=0, max_value=1, allow_nan=False),
)
@settings(max_examples=200)
def test_score_monotonically_non_increasing(r1: float, r2: float):
    """Property 9: Correct guess scoring formula — monotonically non-increasing

    For any two elapsed ratios r1 < r2 at the same position, score(r1) >= score(r2).
    Guessing earlier always yields a score at least as high as guessing later.

    **Validates: Requirements 7.1**
    """
    if r1 > r2:
        r1, r2 = r2, r1

    elapsed1 = r1 * FIXED_DURATION
    elapsed2 = r2 * FIXED_DURATION

    # Same position — time should determine score order
    for position in [1, 2, 3]:
        score1 = compute_guesser_score(elapsed1, FIXED_DURATION, position)
        score2 = compute_guesser_score(elapsed2, FIXED_DURATION, position)

        assert score1 >= score2, (
            f"Monotonicity violated at position {position}: score({r1})={score1} < score({r2})={score2}"
        )
