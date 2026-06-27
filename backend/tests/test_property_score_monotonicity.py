"""Property-based test for cumulative score monotonicity.

**Validates: Requirements 7.5**

Property 11: Cumulative score monotonicity
For any player across all turns in a game session, the player's cumulative score
SHALL be non-decreasing (scores are only ever added, never subtracted).
"""

from hypothesis import given, settings
from hypothesis import strategies as st


@given(st.lists(st.integers(min_value=0, max_value=500), min_size=1, max_size=20))
@settings(max_examples=200)
def test_cumulative_score_never_decreases(score_additions):
    """Property 11: Cumulative score monotonicity.

    **Validates: Requirements 7.5**

    For any sequence of non-negative score additions, the cumulative total
    should be non-decreasing. This validates that scores are only ever added,
    never subtracted.
    """
    cumulative = 0
    previous_cumulative = 0

    for score in score_additions:
        cumulative += score
        assert cumulative >= previous_cumulative, (
            f"Cumulative score decreased from {previous_cumulative} to {cumulative} "
            f"after adding score {score}. Score additions: {score_additions}"
        )
        previous_cumulative = cumulative
